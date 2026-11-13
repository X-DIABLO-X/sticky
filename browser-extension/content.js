/**
 * HeyClicky Clone - Chrome MV3 Content Script
 * 
 * Provides DOM extraction, UI grounding, and automated typing/clicking
 * with MANDATORY, HARD-CODED sensitive-field redaction for passwords,
 * OTPs, credit cards, and SSNs.
 */

(() => {
  // Prevent duplicate script injection
  if (window.__HEYCLICKY_CONTENT_LOADED__) {
    return;
  }
  window.__HEYCLICKY_CONTENT_LOADED__ = true;

  // Sensitive Field Redaction Rules (Strictly enforced, non-bypassable)
  const AUTOCOMPLETE_SENSITIVE_RE = /one-time-code|cc-number|cc-exp|cc-csc|current-password/i;
  const IDENTIFIER_SENSITIVE_RE = /password|passcode|otp|cvv|cvc|ssn|card.?number/i;

  /**
   * Evaluates if a given DOM element contains sensitive credential or payment data.
   * @param {Element} el 
   * @returns {boolean}
   */
  function isSensitiveElement(el) {
    if (!el || !(el instanceof HTMLElement)) {
      return false;
    }

    // Rule 1: type="password"
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'password') {
      return true;
    }

    // Rule 2: autocomplete matching sensitive token patterns
    const autocompleteAttr = (el.getAttribute('autocomplete') || '').trim();
    if (autocompleteAttr && AUTOCOMPLETE_SENSITIVE_RE.test(autocompleteAttr)) {
      return true;
    }

    // Rule 3: name, id, or aria-label matching sensitive keywords
    const idAttr = (el.getAttribute('id') || '').trim();
    const nameAttr = (el.getAttribute('name') || '').trim();
    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    const placeholder = (el.getAttribute('placeholder') || '').trim();

    if (
      IDENTIFIER_SENSITIVE_RE.test(idAttr) ||
      IDENTIFIER_SENSITIVE_RE.test(nameAttr) ||
      IDENTIFIER_SENSITIVE_RE.test(ariaLabel) ||
      IDENTIFIER_SENSITIVE_RE.test(placeholder)
    ) {
      return true;
    }

    // Check parent label or form-group if present
    const parentLabel = el.closest('label');
    if (parentLabel && IDENTIFIER_SENSITIVE_RE.test(parentLabel.textContent || '')) {
      return true;
    }

    return false;
  }

  /**
   * Generates a unique, robust CSS selector for an element.
   * @param {Element} el 
   * @returns {string}
   */
  function getUniqueSelector(el) {
    if (!(el instanceof Element)) return '';

    // 1. Check ID (if valid and not purely dynamic numbers)
    if (el.id && !/^\d+$/.test(el.id) && !/[#.:,[\]]/.test(el.id)) {
      return `#${el.id}`;
    }

    // 2. Check data-testid or data-test
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) {
      return `[data-testid="${CSS.escape(testId)}"]`;
    }

    // 3. Check unique name attribute
    if (el.getAttribute('name')) {
      const name = el.getAttribute('name');
      const matches = document.querySelectorAll(`[name="${CSS.escape(name)}"]`);
      if (matches.length === 1) {
        return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      }
    }

    // 4. Check aria-label
    if (el.getAttribute('aria-label')) {
      const label = el.getAttribute('aria-label');
      const matches = document.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`);
      if (matches.length === 1) {
        return `[aria-label="${CSS.escape(label)}"]`;
      }
    }

    // 5. Fallback: Path from parent
    const path = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id && !/^\d+$/.test(current.id) && !/[#.:,[\]]/.test(current.id)) {
        selector += `#${current.id}`;
        path.unshift(selector);
        break;
      } else {
        let sibling = current;
        let nth = 1;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName.toLowerCase() === selector) nth++;
        }
        if (nth > 1) {
          selector += `:nth-of-type(${nth})`;
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  /**
   * Determines if an element is currently visible in the DOM.
   * @param {Element} el 
   * @returns {boolean}
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.05) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    return true;
  }

  /**
   * Extracts interactive DOM elements from the document with mandatory redaction.
   * @returns {Array<object>}
   */
  function extractDomTree() {
    const candidateSelectors = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="textbox"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ];

    const rawCandidates = Array.from(document.querySelectorAll(candidateSelectors.join(',')));
    const elements = [];
    const seenSelectors = new Set();

    for (const el of rawCandidates) {
      if (!isVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      const selector = getUniqueSelector(el);
      if (seenSelectors.has(selector)) continue;
      seenSelectors.add(selector);

      // MANDATORY REDACTION CHECK:
      if (isSensitiveElement(el)) {
        elements.push({
          selector: selector,
          role: "REDACTED_SENSITIVE_FIELD",
          interactive: false,
          text: "[REDACTED_SENSITIVE_FIELD]",
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom)
          }
        });
        continue;
      }

      // Safe element extraction
      let role = el.getAttribute('role') || el.tagName.toLowerCase();
      let text = (
        el.getAttribute('aria-label') ||
        el.innerText ||
        el.textContent ||
        (el instanceof HTMLInputElement ? el.value || el.placeholder : '') ||
        ''
      ).trim();

      // Normalize text length for token conservation
      if (text.length > 200) {
        text = text.substring(0, 197) + '...';
      }

      elements.push({
        selector: selector,
        role: role,
        interactive: true,
        text: text,
        tag: el.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom)
        }
      });
    }

    return elements;
  }

  /**
   * Simulates a trusted click on a target element.
   * @param {string} selector 
   * @returns {object}
   */
  function clickElement(selector) {
    const el = document.querySelector(selector);
    if (!el) {
      return { success: false, error: `Element not found: ${selector}` };
    }

    try {
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;

      const mouseEvents = ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'];
      for (const evtName of mouseEvents) {
        const evt = new MouseEvent(evtName, {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY
        });
        el.dispatchEvent(evt);
      }

      if (typeof el.focus === 'function') {
        el.focus();
      }

      return { success: true, selector: selector };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Types text into an element with strict refusal on sensitive fields.
   * @param {string} selector 
   * @param {string} text 
   * @returns {object}
   */
  function typeIntoElement(selector, text) {
    const el = document.querySelector(selector);
    if (!el) {
      return { success: false, error: `Element not found: ${selector}` };
    }

    // MANDATORY SENSITIVE REFUSAL
    if (isSensitiveElement(el)) {
      return {
        success: false,
        error: "Refused: sensitive field"
      };
    }

    try {
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      el.focus();

      // Trigger focus event
      el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

      // Handle input / textarea elements
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        // Set value respecting framework property descriptors (React/Vue/Angular)
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, text);
        } else {
          el.value = text;
        }

        // Dispatch synthetic events
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return { success: false, error: `Target element is not an editable field: ${selector}` };
      }

      return { success: true, selector: selector };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // Handle incoming messages from the background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message.action || message.type;

    switch (action) {
      case 'ping':
        sendResponse({ status: 'pong', url: window.location.href, title: document.title });
        break;

      case 'browser_get_dom':
      case 'get_dom': {
        const domTree = extractDomTree();
        sendResponse({
          success: true,
          title: document.title,
          url: window.location.href,
          elements: domTree
        });
        break;
      }

      case 'browser_click':
      case 'click': {
        const result = clickElement(message.selector);
        sendResponse(result);
        break;
      }

      case 'browser_type':
      case 'type': {
        const result = typeIntoElement(message.selector, message.text || '');
        sendResponse(result);
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown action: ${action}` });
        break;
    }

    return true; // Keep channel open for async response
  });
})();
