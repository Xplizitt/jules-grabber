// ==UserScript==
// @name         Jules Chat & Thought Exporter
// @namespace    https://github.com/OpenAI/jules-grabber
// @version      1.0.0
// @description  Capture chat exchanges and model thought history from jules.google.com.
// @author       OpenAI
// @match        https://jules.google.com/*
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    debug: false,
    includeRawPacketsInExport: true,
    autoExpandThoughtSections: true,
    domScanSelectors: [
      '[data-message-id]',
      '[data-msg-id]',
      '[data-testid="chat-message"]',
      '[data-test-id="chat-message"]',
      'c-wiz[message-id]',
      'div[role="listitem"]',
      'article[role="article"]',
      'md-list-item',
      'li[class*="message"]',
      'div[class*="message"]',
    ],
    domTextSelectors: [
      '[data-message-text]',
      '[data-text]',
      '[data-testid="message-text"]',
      '[data-test-id="message-text"]',
      '[class*="markdown"], [class*="message-text"], [class*="response-text"], [class*="prompt-text"]',
      'markdown, rich-text',
    ],
    domThoughtSelectors: [
      '[data-testid*="thought"]',
      '[data-test-id*="thought"]',
      '[class*="thought"]',
      '[class*="reason"]',
      '[class*="deliberation"]',
      '[class*="chain"]',
      'details[open]'
    ],
    thoughtToggleSelector: [
      'button',
      'summary',
    ],
    maxPackets: 250,
    maxMessages: 500,
  };

  const STATUS_NOISE_PATTERN = /^(task (?:is in progress|is completed|encountered an error))( task (?:is in progress|is completed|encountered an error))*$/i;

  const state = {
    packets: [],
    messageMap: new Map(),
    timeline: [],
    observers: [],
    panel: null,
    statusLabel: null,
    lastScan: null,
    pendingDomScan: null,
    menuCommands: [],
  };

  const LOGGER_PREFIX = '[JulesExporter]';

  function log(...args) {
    if (CONFIG.debug) {
      console.log(LOGGER_PREFIX, ...args);
    }
  }

  function info(...args) {
    console.log(LOGGER_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOGGER_PREFIX, ...args);
  }

  function error(...args) {
    console.error(LOGGER_PREFIX, ...args);
  }

  function init() {
    if (state.initialised) {
      return;
    }
    state.initialised = true;

    info('Initialising Jules chat exporter userscript.');

    setupNetworkInterceptors();
    setupDomObserver();
    createUiPanel();
    registerMenuCommands();

    setTimeout(() => scanDomForMessages('initial'), 1500);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') {
      return;
    }
    state.menuCommands.forEach(id => {
      if (typeof GM_unregisterMenuCommand === 'function') {
        try { GM_unregisterMenuCommand(id); } catch (err) { log('Failed to unregister command', err); }
      }
    });
    state.menuCommands.length = 0;

    const commands = [
      {
        label: 'Jules Exporter: Export JSON',
        action: () => exportConversation('json'),
      },
      {
        label: 'Jules Exporter: Export Markdown',
        action: () => exportConversation('markdown'),
      },
      {
        label: 'Jules Exporter: Copy summary to clipboard',
        action: () => copySummaryToClipboard(),
      },
      {
        label: 'Jules Exporter: Trigger DOM rescan',
        action: () => scanDomForMessages('manual-menu'),
      },
      {
        label: 'Jules Exporter: Toggle debug logs',
        action: () => {
          CONFIG.debug = !CONFIG.debug;
          info('Debug logging', CONFIG.debug ? 'enabled' : 'disabled');
        },
      },
    ];

    commands.forEach(cmd => {
      try {
        const id = GM_registerMenuCommand(cmd.label, cmd.action);
        if (id) {
          state.menuCommands.push(id);
        }
      } catch (err) {
        warn('Failed to register menu command', cmd.label, err);
      }
    });
  }

  function setupNetworkInterceptors() {
    interceptFetch();
    interceptXhr();
  }

  function interceptFetch() {
    if (!window.fetch) {
      warn('Fetch API not present; network capture will be limited.');
      return;
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function(resource, init) {
      const startTime = performance.now();
      const response = await nativeFetch(resource, init);
      try {
        const clone = response.clone();
        clone.text().then(bodyText => {
          if (bodyText) {
            handleNetworkPacket(resource, init, bodyText, {
              startTime,
              endTime: performance.now(),
              status: response.status,
              from: 'fetch',
            });
          }
        }).catch(err => {
          log('Failed to read fetch response body', err);
        });
      } catch (err) {
        log('Failed to clone fetch response', err);
      }
      return response;
    };
  }

  function interceptXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
      this.__julesExporter = this.__julesExporter || {};
      this.__julesExporter.method = method;
      this.__julesExporter.url = url;
      this.__julesExporter.startTime = performance.now();
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      this.__julesExporter = this.__julesExporter || {};
      this.__julesExporter.requestBody = body;
      this.addEventListener('load', function() {
        const meta = this.__julesExporter || {};
        if (this.responseType && this.responseType !== '' && this.responseType !== 'text') {
          return;
        }
        const responseText = this.responseText;
        if (!responseText) {
          return;
        }
        meta.status = this.status;
        meta.from = 'xhr';
        meta.endTime = performance.now();
        handleNetworkPacket(meta.url, { method: meta.method, body }, responseText, meta);
      });
      return originalSend.apply(this, arguments);
    };
  }

  function getUrlFromResource(resource) {
    if (!resource) {
      return '';
    }
    if (typeof resource === 'string') {
      return resource;
    }
    if (resource && typeof resource.url === 'string') {
      return resource.url;
    }
    return String(resource);
  }

  function handleNetworkPacket(resource, init, bodyText, meta = {}) {
    const url = getUrlFromResource(resource);
    if (!url || typeof bodyText !== 'string' || !bodyText.trim()) {
      return;
    }

    const packet = {
      url,
      method: init && init.method ? init.method : (meta.method || 'GET'),
      requestBody: init && init.body ? init.body : meta.requestBody,
      responseBody: bodyText,
      status: meta.status || null,
      from: meta.from || 'fetch',
      capturedAt: new Date().toISOString(),
    };

    state.packets.push(packet);
    if (state.packets.length > CONFIG.maxPackets) {
      state.packets.splice(0, state.packets.length - CONFIG.maxPackets);
    }

    const payloads = parseResponseBody(bodyText);
    if (payloads.length) {
      payloads.forEach(payload => processPayload(payload, packet));
    }

    refreshStatus();
  }

  function parseResponseBody(bodyText) {
    const results = [];
    const trimmed = bodyText.trim();
    if (!trimmed) {
      return results;
    }

    const withoutGuard = trimmed.replace(/^\)\]\}'\n?/, '');
    const potentialSegments = [withoutGuard];

    if (withoutGuard.includes('\n')) {
      withoutGuard.split('\n').forEach(segment => {
        const s = segment.trim();
        if (s) {
          potentialSegments.push(s);
        }
      });
    }

    const seenObjects = new WeakSet();

    function tryParse(segment) {
      try {
        return JSON.parse(segment);
      } catch (err) {
        return undefined;
      }
    }

    potentialSegments.forEach(segment => {
      if (!segment) {
        return;
      }
      const parsed = tryParse(segment);
      if (parsed !== undefined) {
        collectRecursive(parsed, results, seenObjects, 0);
      } else if (segment.startsWith('[') || segment.startsWith('{')) {
        const relaxed = segment.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');
        const parsedRelaxed = tryParse(relaxed);
        if (parsedRelaxed !== undefined) {
          collectRecursive(parsedRelaxed, results, seenObjects, 0);
        }
      }
    });

    return results;
  }

  function collectRecursive(value, bucket, seen, depth, path = '$') {
    if (value === null || typeof value === 'undefined') {
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          collectRecursive(parsed, bucket, seen, depth + 1, path + ' > string-json');
        } catch (err) {
        }
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    bucket.push(value);

    if (depth > 6) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectRecursive(item, bucket, seen, depth + 1, `${path}[${index}]`);
      });
    } else {
      Object.entries(value).forEach(([key, val]) => {
        collectRecursive(val, bucket, seen, depth + 1, `${path}.${key}`);
      });
    }
  }

  function processPayload(payload, packetMeta) {
    if (!payload) {
      return;
    }

    try {
      const messageBatches = findMessageCollections(payload);
      if (!messageBatches.length) {
        return;
      }
      messageBatches.forEach(batch => {
        const { messages, containerPath } = batch;
        messages.forEach((message, index) => {
          const normalized = normalizeMessage(message, {
            path: containerPath,
            index,
            packetMeta,
          });
          if (normalized) {
            upsertMessage(normalized);
          }
        });
      });
    } catch (err) {
      warn('Failed to process payload', err);
    }
  }

  function findMessageCollections(value, path = '$') {
    const collections = [];
    const seen = new WeakSet();

    function walk(node, currentPath) {
      if (!node) {
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      if (seen.has(node)) {
        return;
      }
      seen.add(node);

      if (Array.isArray(node)) {
        if (node.length && node.every(isMessageLikeCandidate)) {
          collections.push({ messages: node, containerPath: currentPath });
        } else {
          node.forEach((child, index) => {
            walk(child, `${currentPath}[${index}]`);
          });
        }
        return;
      }

      if (node.messages && Array.isArray(node.messages) && node.messages.some(Boolean)) {
        collections.push({ messages: node.messages, containerPath: `${currentPath}.messages` });
      }

      if (node.conversation && Array.isArray(node.conversation)) {
        collections.push({ messages: node.conversation, containerPath: `${currentPath}.conversation` });
      }

      Object.entries(node).forEach(([key, child]) => {
        if (key === 'messages' || key === 'conversation') {
          return;
        }
        walk(child, `${currentPath}.${key}`);
      });
    }

    walk(value, path);
    return collections;
  }

  function isMessageLikeCandidate(item) {
    if (item === null || typeof item === 'undefined') {
      return false;
    }
    if (typeof item === 'string') {
      return item.trim().length > 0;
    }
    if (Array.isArray(item)) {
      if (!item.length) {
        return false;
      }
      return item.some(el => typeof el === 'string' || (el && typeof el === 'object'));
    }
    if (typeof item === 'object') {
      const keys = Object.keys(item);
      if (!keys.length) {
        return false;
      }
      const interestingKeys = [
        'id', 'messageId', 'conversationNodeId', 'sender', 'author', 'role', 'content', 'parts', 'text', 'formatted', 'thought', 'thoughts', 'thinking', 'modelTrace', 'rawContent', 'response', 'prompt', 'metadata'
      ];
      if (keys.some(key => interestingKeys.includes(key))) {
        return true;
      }
      if (keys.some(key => /message|content|text|candidate/i.test(key))) {
        return true;
      }
      return false;
    }
    return false;
  }

  function normalizeMessage(raw, context = {}) {
    if (!raw) {
      return null;
    }

    let id = extractMessageId(raw);
    const role = extractRole(raw, context);
    const timestamp = extractTimestamp(raw);
    const textParts = extractTextParts(raw);
    const thoughtParts = extractThoughtParts(raw);
    const citations = extractCitations(raw);

    if (!id) {
      id = computeDeterministicId(role, textParts, thoughtParts, timestamp, context);
    }

    if (!textParts.length && !thoughtParts.length) {
      return null;
    }

    const combinedText = textParts.join(' ').trim();
    if (combinedText && isKnownStatusNoise(combinedText) && !thoughtParts.length) {
      return null;
    }

    const normalizedContext = {
      path: context.path,
      index: context.index,
      packet: context.packetMeta ? sanitizePacketMeta(context.packetMeta) : undefined,
    };

    return {
      id,
      role,
      timestamp,
      text: textParts.join('\n').trim(),
      textParts,
      thoughts: thoughtParts,
      citations,
      raw,
      context: normalizedContext,
      firstSeen: new Date().toISOString(),
    };
  }

  function extractMessageId(raw) {
    const candidates = [
      raw.id,
      raw.mid,
      raw.messageId,
      raw.serverMessageId,
      raw.message?.id,
      raw.metadata?.id,
      raw.message?.messageId,
      raw.clientMessageId,
      raw.conversationNodeId,
      raw.nodeId,
      raw.message?.clientSideMessageId,
      raw.msgId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
      if (typeof candidate === 'number') {
        return String(candidate);
      }
    }
    if (Array.isArray(raw) && raw.length) {
      const maybeId = raw.find(val => typeof val === 'string' && /msg|conv|node/i.test(val));
      if (maybeId) {
        return maybeId;
      }
    }
    return null;
  }

  function extractRole(raw, context = {}) {
    const candidates = [
      raw.role,
      raw.author,
      raw.speaker,
      raw.sender,
      raw.message?.role,
      raw.message?.author,
      raw.metadata?.speaker,
      raw.metadata?.role,
      raw.participant,
      raw.participantRole,
      raw.actor,
      raw.userType,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim().toLowerCase();
      }
      if (candidate && typeof candidate.name === 'string') {
        return candidate.name.toLowerCase();
      }
    }

    if (Array.isArray(raw)) {
      const userHint = raw.find(val => typeof val === 'string' && /(user|you|human)/i.test(val));
      if (userHint) {
        return 'user';
      }
      const modelHint = raw.find(val => typeof val === 'string' && /(assistant|model|jules)/i.test(val));
      if (modelHint) {
        return 'assistant';
      }
    }

    if (typeof context.index === 'number') {
      return context.index % 2 === 0 ? 'user' : 'assistant';
    }

    return 'assistant';
  }

  function extractTimestamp(raw) {
    const candidates = [
      raw.timestamp,
      raw.time,
      raw.createTime,
      raw.updateTime,
      raw.metadata?.timestamp,
      raw.message?.timestamp,
      raw.header?.timestamp,
      raw.createdAt,
      raw.updatedAt,
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
      if (typeof candidate === 'number') {
        if (candidate > 1e12) {
          return new Date(candidate).toISOString();
        }
        if (candidate > 1e9) {
          return new Date(candidate * 1000).toISOString();
        }
      }
    }
    return null;
  }

  function extractTextParts(raw) {
    const parts = [];

    const tryPush = value => {
      if (!value) {
        return;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
          parts.push(trimmed);
        }
        return;
      }
      if (typeof value === 'number') {
        parts.push(String(value));
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(tryPush);
        return;
      }
      if (typeof value === 'object') {
        if (value.text) {
          tryPush(value.text);
        }
        if (value.content) {
          tryPush(value.content);
        }
        if (value.formattedText) {
          tryPush(value.formattedText);
        }
        if (value.markdown) {
          tryPush(value.markdown);
        }
        if (value.plainText) {
          tryPush(value.plainText);
        }
        if (value.parts && Array.isArray(value.parts)) {
          value.parts.forEach(part => {
            if (part && (part.text || part.markdown || part.html)) {
              tryPush(part.text || part.markdown || part.html);
            } else if (part && part.content) {
              tryPush(part.content);
            }
          });
        }
        if (value.candidates && Array.isArray(value.candidates)) {
          value.candidates.forEach(candidate => {
            tryPush(candidate.content || candidate.text || candidate.response || candidate.output);
          });
        }
        if (value.response && typeof value.response === 'object') {
          tryPush(value.response.text || value.response.output || value.response.markdown);
        }
        if (value.prompt && typeof value.prompt === 'object') {
          tryPush(value.prompt.text || value.prompt.markdown);
        }
      }
    };

    tryPush(raw);

    return uniqueStrings(parts);
  }

  function extractThoughtParts(raw) {
    const parts = [];
    const keys = [
      'thought',
      'thoughts',
      'thinking',
      'deliberation',
      'chainOfThought',
      'chain_of_thought',
      'modelTrace',
      'internalMonologue',
      'reasoning',
      'scratchpad',
      'analysis',
      'reflection',
      'explanations',
      'hiddenTrace',
      'coT',
    ];

    const pushValue = value => {
      if (!value) {
        return;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
          parts.push(trimmed);
        }
        return;
      }
      if (typeof value === 'number') {
        parts.push(String(value));
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(pushValue);
        return;
      }
      if (typeof value === 'object') {
        if (value.text || value.markdown || value.html) {
          pushValue(value.text || value.markdown || value.html);
        }
        if (value.parts && Array.isArray(value.parts)) {
          value.parts.forEach(part => {
            if (!part) { return; }
            if (part.mimeType && /thought|reason/i.test(part.mimeType)) {
              pushValue(part.text || part.content || part.rawText);
            }
            if (part.category && /thought|reason/i.test(part.category)) {
              pushValue(part.text || part.content);
            }
          });
        }
        if (value.trace && typeof value.trace === 'object') {
          pushValue(value.trace.steps || value.trace.text);
        }
      }
    };

    keys.forEach(key => {
      if (raw && Object.prototype.hasOwnProperty.call(raw, key)) {
        pushValue(raw[key]);
      }
    });

    if (raw && raw.metadata) {
      keys.forEach(key => {
        if (raw.metadata && Object.prototype.hasOwnProperty.call(raw.metadata, key)) {
          pushValue(raw.metadata[key]);
        }
      });
      if (raw.metadata.debugInfo) {
        pushValue(raw.metadata.debugInfo);
      }
    }

    if (raw && raw.debugInfo) {
      pushValue(raw.debugInfo);
    }

    if (raw && raw.internalState) {
      pushValue(raw.internalState);
    }

    return uniqueStrings(parts);
  }

  function extractCitations(raw) {
    const citations = [];
    const addCitation = item => {
      if (!item) {
        return;
      }
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) {
          citations.push({ text: trimmed });
        }
        return;
      }
      if (typeof item === 'object') {
        const citation = {
          text: '',
          url: '',
          title: '',
          ...item,
        };
        if (item.url && typeof item.url === 'string') {
          citation.url = item.url;
        }
        if (item.title && typeof item.title === 'string') {
          citation.title = item.title;
        }
        if (item.text && typeof item.text === 'string') {
          citation.text = item.text;
        } else if (item.snippet && typeof item.snippet === 'string') {
          citation.text = item.snippet;
        }
        citations.push(citation);
      }
    };

    if (raw && raw.citations) {
      if (Array.isArray(raw.citations)) {
        raw.citations.forEach(addCitation);
      } else {
        addCitation(raw.citations);
      }
    }

    if (raw && raw.metadata && raw.metadata.citations) {
      if (Array.isArray(raw.metadata.citations)) {
        raw.metadata.citations.forEach(addCitation);
      } else {
        addCitation(raw.metadata.citations);
      }
    }

    if (raw && raw.message && raw.message.citations) {
      addCitation(raw.message.citations);
    }

    return citations;
  }

  function computeDeterministicId(role, textParts, thoughtParts, timestamp, context) {
    const base = JSON.stringify({
      role,
      textParts,
      thoughtParts,
      timestamp,
      path: context.path,
      index: context.index,
    });
    return `hash_${hashString(base)}`;
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function uniqueStrings(items) {
    const seen = new Set();
    const result = [];
    items.forEach(item => {
      const normalized = typeof item === 'string' ? item.trim() : item;
      if (!normalized) {
        return;
      }
      const key = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(normalized);
      }
    });
    return result;
  }

  function isKnownStatusNoise(text) {
    if (!text) {
      return false;
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return false;
    }
    return STATUS_NOISE_PATTERN.test(normalized);
  }

  function upsertMessage(message) {
    if (!message || !message.id) {
      return;
    }

    let existing = state.messageMap.get(message.id);
    if (!existing) {
      existing = {
        ...message,
      };
      state.messageMap.set(message.id, existing);
      state.timeline.push(message.id);
      if (state.timeline.length > CONFIG.maxMessages) {
        const removed = state.timeline.splice(0, state.timeline.length - CONFIG.maxMessages);
        removed.forEach(id => state.messageMap.delete(id));
      }
    } else {
      existing.text = existing.text || message.text;
      existing.textParts = uniqueStrings([...(existing.textParts || []), ...(message.textParts || [])]);
      existing.thoughts = uniqueStrings([...(existing.thoughts || []), ...(message.thoughts || [])]);
      existing.citations = [...(existing.citations || []), ...(message.citations || [])];
      existing.timestamp = existing.timestamp || message.timestamp;
      existing.lastUpdated = new Date().toISOString();
    }

    refreshStatus();
  }

  function sanitizePacketMeta(packet) {
    if (!packet) {
      return null;
    }
    return {
      url: packet.url,
      method: packet.method,
      status: packet.status,
      from: packet.from,
      capturedAt: packet.capturedAt,
    };
  }

  function getMessagesInOrder() {
    return state.timeline
      .map(id => state.messageMap.get(id))
      .filter(Boolean);
  }

  function generateExportPayload() {
    const messages = getMessagesInOrder();
    const messagePayload = messages.map(msg => ({
      id: msg.id,
      role: msg.role,
      timestamp: msg.timestamp,
      text: msg.text,
      textParts: msg.textParts,
      thoughts: msg.thoughts,
      citations: msg.citations,
      firstSeen: msg.firstSeen,
      lastUpdated: msg.lastUpdated || msg.firstSeen,
      source: msg.context,
    }));

    const totalThoughts = messages.reduce((sum, msg) => sum + (msg.thoughts ? msg.thoughts.length : 0), 0);

    const payload = {
      exportedAt: new Date().toISOString(),
      totalMessages: messages.length,
      totalThoughtFragments: totalThoughts,
      messages: messagePayload,
    };

    if (CONFIG.includeRawPacketsInExport) {
      payload.capturedPackets = state.packets;
    }

    return payload;
  }

  function exportConversation(format = 'json') {
    const messages = getMessagesInOrder();
    if (!messages.length) {
      notify('No Jules messages captured yet. Try sending a prompt or forcing a DOM rescan.');
      return;
    }

    if (format === 'json') {
      const payload = generateExportPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `${createFileName('jules-chat')}.json`);
      notify(`Exported ${messages.length} messages to JSON.`);
      return;
    }

    if (format === 'markdown' || format === 'md') {
      const markdown = buildMarkdownExport(messages);
      const blob = new Blob([markdown], { type: 'text/markdown' });
      downloadBlob(blob, `${createFileName('jules-chat')}.md`);
      notify(`Exported ${messages.length} messages to Markdown.`);
      return;
    }

    warn('Unknown export format', format);
  }

  function buildMarkdownExport(messages) {
    const lines = [];
    lines.push(`# Jules conversation export`);
    lines.push(`_Exported at ${new Date().toISOString()}_\n`);

    messages.forEach((msg, idx) => {
      const roleLabel = msg.role ? msg.role.charAt(0).toUpperCase() + msg.role.slice(1) : 'Message';
      const timestamp = msg.timestamp ? ` (${msg.timestamp})` : '';
      lines.push(`## ${idx + 1}. ${roleLabel}${timestamp}`);
      lines.push('');
      if (msg.text) {
        lines.push(msg.text);
        lines.push('');
      }
      if (msg.thoughts && msg.thoughts.length) {
        lines.push('> **Thought history**');
        msg.thoughts.forEach(thought => {
          const sanitized = thought.replace(/\n/g, '\n> ');
          lines.push(`> ${sanitized}`);
        });
        lines.push('');
      }
      if (msg.citations && msg.citations.length) {
        lines.push('> **Citations**');
        msg.citations.forEach((citation, cIdx) => {
          const text = citation.text || 'Citation';
          const url = citation.url ? ` (${citation.url})` : '';
          lines.push(`> ${cIdx + 1}. ${text}${url}`);
        });
        lines.push('');
      }
      lines.push('');
    });

    return `${lines.join('\n').trim()}\n`;
  }

  function createFileName(prefix) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${prefix}-${timestamp}`;
  }

  function downloadBlob(blob, fileName) {
    if (typeof GM_download === 'function') {
      try {
        GM_download({
          url: URL.createObjectURL(blob),
          name: fileName,
          saveAs: true,
        });
        return;
      } catch (err) {
        warn('GM_download failed, falling back to anchor download', err);
      }
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 1000);
  }

  function copySummaryToClipboard() {
    const messages = getMessagesInOrder();
    if (!messages.length) {
      notify('No messages captured yet.');
      return;
    }
    const summary = buildSummaryText(messages);
    copyText(summary).then(() => {
      notify('Conversation summary copied to clipboard.');
    }).catch(err => {
      error('Failed to copy summary to clipboard', err);
      notify('Failed to copy conversation summary. Check console for details.');
    });
  }

  function buildSummaryText(messages) {
    const lines = [];
    lines.push(`Jules conversation export (${new Date().toISOString()})`);
    lines.push('');
    messages.forEach((msg, idx) => {
      const role = msg.role || 'assistant';
      lines.push(`${idx + 1}. [${role}] ${msg.text}`);
      if (msg.thoughts && msg.thoughts.length) {
        msg.thoughts.forEach(thought => {
          lines.push(`    - thought: ${thought}`);
        });
      }
    });
    return lines.join('\n');
  }

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      return new Promise((resolve, reject) => {
        try {
          GM_setClipboard(text, 'text');
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise((resolve, reject) => {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function notify(message) {
    if (typeof GM_notification === 'function') {
      try {
        GM_notification({
          text: message,
          title: 'Jules Exporter',
          timeout: 4000,
        });
        return;
      } catch (err) {
        log('GM_notification failed', err);
      }
    }
    info(message);
  }

  function refreshStatus() {
    if (!state.panel || !state.statusLabel) {
      return;
    }
    const messageCount = state.messageMap.size;
    const thoughtCount = getMessagesInOrder().reduce((sum, msg) => sum + (msg.thoughts ? msg.thoughts.length : 0), 0);
    const packetCount = state.packets.length;
    const statusText = `${messageCount} messages • ${thoughtCount} thought fragments • ${packetCount} packets`;
    state.statusLabel.textContent = statusText;
  }

  function createUiPanel() {
    if (state.panel) {
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'jules-exporter-panel';
    panel.innerHTML = `
      <div class="jules-exporter-header">
        <span class="jules-exporter-title">Jules Exporter</span>
        <div class="jules-exporter-actions">
          <button data-action="export-json">Export JSON</button>
          <button data-action="export-md">Export MD</button>
          <button data-action="copy-summary">Copy</button>
          <button data-action="scan-dom">Rescan</button>
        </div>
      </div>
      <div class="jules-exporter-status">Capturing…</div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      .jules-exporter-panel {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 99999;
        width: 280px;
        background: rgba(18, 18, 18, 0.92);
        color: #f5f5f5;
        font-family: 'Roboto', 'Segoe UI', sans-serif;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        overflow: hidden;
      }
      .jules-exporter-panel button {
        background: rgba(255, 255, 255, 0.12);
        color: #f5f5f5;
        border: none;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        margin-left: 6px;
        transition: background 0.2s ease;
      }
      .jules-exporter-panel button:hover {
        background: rgba(255, 255, 255, 0.24);
      }
      .jules-exporter-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px;
      }
      .jules-exporter-title {
        font-weight: 600;
        font-size: 14px;
      }
      .jules-exporter-actions {
        display: flex;
        align-items: center;
      }
      .jules-exporter-status {
        padding: 10px 12px 12px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.75);
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      @media (max-width: 768px) {
        .jules-exporter-panel {
          width: calc(100% - 24px);
          right: 12px;
          left: 12px;
          bottom: 12px;
        }
        .jules-exporter-header {
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
        }
        .jules-exporter-actions {
          flex-wrap: wrap;
        }
        .jules-exporter-actions button {
          margin-left: 0;
          margin-right: 6px;
          margin-bottom: 4px;
        }
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    const statusLabel = panel.querySelector('.jules-exporter-status');
    state.panel = panel;
    state.statusLabel = statusLabel;

    panel.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) {
        return;
      }
      const action = button.getAttribute('data-action');
      switch (action) {
        case 'export-json':
          exportConversation('json');
          break;
        case 'export-md':
          exportConversation('markdown');
          break;
        case 'copy-summary':
          copySummaryToClipboard();
          break;
        case 'scan-dom':
          scanDomForMessages('manual-button');
          break;
        default:
          break;
      }
    });

    refreshStatus();
  }

  function setupDomObserver() {
    if (state.domObserver) {
      return;
    }

    const observer = new MutationObserver(() => {
      scheduleDomScan('mutation');
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    state.domObserver = observer;
  }

  function scheduleDomScan(reason) {
    state.lastScanReason = reason;
    if (state.pendingDomScan) {
      clearTimeout(state.pendingDomScan);
    }
    state.pendingDomScan = setTimeout(() => {
      scanDomForMessages(reason);
    }, 500);
  }

  function scanDomForMessages(reason = 'manual') {
    state.lastScan = new Date().toISOString();
    log('Scanning DOM for messages', reason);

    if (CONFIG.autoExpandThoughtSections) {
      expandThoughtSections();
    }

    const domMessages = extractMessagesFromDom();
    domMessages.forEach(msg => upsertMessage(msg));
    refreshStatus();
  }

  function expandThoughtSections() {
    const toggleSelectors = CONFIG.thoughtToggleSelector || [];
    const toggles = [];
    toggleSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(element => {
        if (!element) { return; }
        const text = element.textContent || '';
        if (/thought|reason|deliberation|process|work|steps|chain/i.test(text)) {
          toggles.push(element);
        }
      });
    });

    toggles.forEach(toggle => {
      try {
        const expanded = toggle.getAttribute('aria-expanded');
        if (toggle.tagName.toLowerCase() === 'summary') {
          const details = toggle.closest('details');
          if (details && !details.open) {
            details.open = true;
          }
        } else if (expanded === 'false' || expanded === null) {
          toggle.click();
        }
      } catch (err) {
        log('Failed to expand thought toggle', err);
      }
    });
  }

  function extractMessagesFromDom() {
    const results = [];
    const selectors = CONFIG.domScanSelectors || [];
    const seenNodes = new Set();
    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(node => {
        if (!node || seenNodes.has(node)) {
          return;
        }
        const normalized = normalizeDomMessage(node);
        if (normalized) {
          results.push(normalized);
          seenNodes.add(node);
        }
      });
    });
    return results;
  }

  function computeDomNodeSignature(node) {
    if (!node || node.nodeType !== 1) {
      return 'dom:unknown';
    }

    const segments = [];
    let current = node;
    let depth = 0;

    while (current && current.nodeType === 1 && depth < 25) {
      let segment = current.tagName ? current.tagName.toLowerCase() : 'element';

      if (current.id && current.id.trim()) {
        segment += `#${current.id.trim()}`;
        segments.unshift(segment);
        break;
      }

      const keyAttributePairs = [
        ['data-message-id', current.getAttribute('data-message-id')],
        ['data-msg-id', current.getAttribute('data-msg-id')],
        ['data-item-id', current.getAttribute('data-item-id')],
        ['data-test-id', current.getAttribute('data-test-id')],
        ['data-testid', current.getAttribute('data-testid')],
      ].filter(([, value]) => Boolean(value));
      if (keyAttributePairs.length) {
        segment += keyAttributePairs
          .slice(0, 2)
          .map(([name, value]) => `[${name}=${value}]`)
          .join('');
      } else {
        const classList = typeof current.className === 'string'
          ? current.className.trim().split(/\s+/).filter(Boolean)
          : [];
        if (classList.length) {
          segment += `.${classList.slice(0, 3).join('.')}`;
        }
      }

      let siblingIndex = 0;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) {
          siblingIndex += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      segment += `:nth-of-type(${siblingIndex + 1})`;

      segments.unshift(segment);

      if (current.parentElement) {
        current = current.parentElement;
      } else {
        break;
      }

      if (typeof document !== 'undefined') {
        if (current === document.body || current === document.documentElement) {
          const rootTag = current.tagName ? current.tagName.toLowerCase() : 'root';
          segments.unshift(rootTag);
          break;
        }
      }

      depth += 1;
    }

    return `dom:${segments.join('>')}`;
  }

  function normalizeDomMessage(node) {
    if (!node) {
      return null;
    }
    const dataset = node.dataset || {};
    const idCandidates = [
      dataset.messageId,
      dataset.msgId,
      dataset.itemId,
      node.getAttribute('data-message-id'),
      node.getAttribute('data-msg-id'),
      node.id,
    ];
    let id = idCandidates.find(candidate => candidate && candidate.trim());

    if (!id && dataset.julesExporterId) {
      id = dataset.julesExporterId;
    }

    const roleCandidates = [
      dataset.role,
      dataset.sender,
      dataset.author,
      node.getAttribute('data-role'),
      node.getAttribute('data-sender'),
    ];
    let role = roleCandidates.find(candidate => candidate && candidate.trim());

    if (!role) {
      role = node.className && /user|human/i.test(node.className) ? 'user' : 'assistant';
    }

    const text = extractVisibleText(node, CONFIG.domTextSelectors);
    const thoughts = extractVisibleThoughts(node, CONFIG.domThoughtSelectors);

    if ((!text || isKnownStatusNoise(text)) && !thoughts.length) {
      return null;
    }

    if (!id) {
      const signature = computeDomNodeSignature(node);
      id = computeDeterministicId(role, [text], thoughts, null, { path: signature, index: 0 });
      try {
        node.dataset.julesExporterId = id;
      } catch (err) {
        log('Failed to store exporter id on DOM node', err);
      }
    } else if (!dataset.julesExporterId) {
      try {
        node.dataset.julesExporterId = id;
      } catch (err) {
        log('Failed to persist existing message id on DOM node', err);
      }
    }

    return {
      id,
      role,
      timestamp: null,
      text,
      textParts: text ? [text] : [],
      thoughts,
      citations: [],
      raw: { from: 'dom', outerHTML: node.outerHTML },
      context: {
        path: 'dom',
        index: state.timeline.length,
      },
      firstSeen: new Date().toISOString(),
    };
  }

  function extractVisibleText(node, textSelectors) {
    if (!node) {
      return '';
    }
    if (textSelectors && textSelectors.length) {
      for (const selector of textSelectors) {
        const textNode = node.querySelector(selector);
        if (textNode) {
          const text = sanitizeNodeText(textNode);
          if (text) {
            return text;
          }
        }
      }
    }
    return sanitizeNodeText(node);
  }

  function extractVisibleThoughts(node, thoughtSelectors) {
    const thoughts = [];
    if (!node) {
      return thoughts;
    }
    if (thoughtSelectors && thoughtSelectors.length) {
      thoughtSelectors.forEach(selector => {
        node.querySelectorAll(selector).forEach(thoughtNode => {
          const text = sanitizeNodeText(thoughtNode);
          if (text) {
            thoughts.push(text);
          }
        });
      });
    }
    return uniqueStrings(thoughts);
  }

  function sanitizeNodeText(node) {
    if (!node) {
      return '';
    }
    const clone = node.cloneNode(true);
    clone.querySelectorAll('button, svg, style, script, input, textarea, select').forEach(el => el.remove());
    const text = clone.innerText || clone.textContent || '';
    return text.replace(/\s+$/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  function bootstrap() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      init();
    } else {
      window.addEventListener('DOMContentLoaded', init);
      window.addEventListener('load', init);
    }
  }

  bootstrap();
})();

