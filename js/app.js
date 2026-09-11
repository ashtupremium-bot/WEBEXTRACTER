(() => {
  const form = document.getElementById('extract-form');
  const urlInput = document.getElementById('url-input');
  const inputShell = document.getElementById('input-shell');
  const extractBtn = document.getElementById('extract-btn');
  const clearBtn = document.getElementById('clear-btn');
  const errorBanner = document.getElementById('error-banner');
  const loadingState = document.getElementById('loading-state');
  const resultSection = document.getElementById('result-section');
  const resultList = document.getElementById('result-list');
  const outputText = document.getElementById('output-text');
  const copyBtn = document.getElementById('copy-btn');
  const NOT_AVAILABLE = 'Not Available';
  let isRequestInFlight = false;
  let currentController = null;

  function looksLikeMapsUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const shortHosts = ['goo.gl', 'maps.app.goo.gl', 'g.page', 'app.goo.gl', 'share.google', 'g.co'];
      return shortHosts.includes(host) || (host.includes('google.') && (host.startsWith('maps.') || url.pathname.startsWith('/maps') || url.searchParams.has('cid')));
    } catch { return false; }
  }

  function setError(message) {
    errorBanner.hidden = !message;
    errorBanner.textContent = message || '';
    inputShell.classList.toggle('invalid', Boolean(message));
  }

  function setLoading(loading) {
    isRequestInFlight = loading;
    extractBtn.disabled = loading;
    extractBtn.classList.toggle('is-loading', loading);
    inputShell.classList.toggle('scanning', loading);
    urlInput.disabled = loading;
    loadingState.hidden = !loading;
    if (loading) resultSection.hidden = true;
  }

  function copyText(text, button) {
    navigator.clipboard.writeText(text).catch(() => {
      const temporary = document.createElement('textarea');
      temporary.value = text;
      document.body.appendChild(temporary);
      temporary.select();
      document.execCommand('copy');
      temporary.remove();
    });
    if (button) {
      button.classList.add('copied');
      setTimeout(() => button.classList.remove('copied'), 1600);
    }
  }

  function makeValue(value, options = {}) {
    const node = document.createElement('dd');
    if (options.mono) node.classList.add('mono');
    if (value === null || value === undefined || value === '') {
      node.textContent = NOT_AVAILABLE;
      node.classList.add('unavailable');
    } else if (options.link) {
      const anchor = document.createElement('a');
      anchor.href = value;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = value;
      node.appendChild(anchor);
    } else node.textContent = value;
    return node;
  }

  function makeRow(icon, label, value) {
    const wrapper = document.createElement('div');
    wrapper.className = 'record-row';
    const labelNode = document.createElement('dt');
    const iconNode = document.createElement('span');
    iconNode.className = 'record-icon';
    iconNode.dataset.icon = icon;
    labelNode.append(iconNode, document.createTextNode(label));
    wrapper.append(labelNode, value);
    return wrapper;
  }

  function makePhones(phones) {
    if (!phones || !phones.length) return makeValue(null, { mono: true });
    const node = document.createElement('dd');
    node.className = 'mono';
    phones.forEach((phone) => {
      const entry = document.createElement('div');
      entry.className = 'phone-entry';
      const number = document.createElement('strong');
      number.className = 'phone-value';
      number.textContent = phone;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-accent btn-sm phone-copy';
      button.innerHTML = '<span class="copy-label">Copy</span><span class="copied-badge" aria-hidden="true">Copied!</span>';
      button.addEventListener('click', () => copyText(phone, button));
      entry.append(number, button);
      node.appendChild(entry);
    });
    return node;
  }

  function formatText(data, index) {
    const phones = data.phones && data.phones.length ? data.phones.join(', ') : NOT_AVAILABLE;
    const rating = data.rating !== null && data.rating !== undefined ? `${data.rating.toFixed(1)}/5` : NOT_AVAILABLE;
    const reviews = data.reviewCount !== null && data.reviewCount !== undefined ? data.reviewCount.toLocaleString('en-US') : NOT_AVAILABLE;
    return [`${index}) Business Name: ${data.name || NOT_AVAILABLE}`, `Phone Number: ${phones}`, `Location: ${data.address || NOT_AVAILABLE}`, `Google Review Count: ${reviews}`, `Google Rating: ${rating}`, `Website: ${data.website || NOT_AVAILABLE}`].join('\n');
  }

  function renderResults(records) {
    resultList.replaceChildren();
    records.forEach((data, index) => {
      const card = document.createElement('div');
      card.className = 'card result-card';
      const header = document.createElement('div');
      header.className = 'result-card-head';
      const title = document.createElement('h2');
      title.className = 'result-name';
      title.textContent = `${index + 1}) ${data.name || 'Business name unavailable'}`;
      const flag = document.createElement('span');
      flag.className = 'result-flag';
      flag.textContent = 'Extracted';
      header.append(title, flag);
      const list = document.createElement('dl');
      list.className = 'record-list';
      list.append(
        makeRow('phone', 'Phone Number(s)', makePhones(data.phones)),
        makeRow('pin', 'Location', makeValue(data.address)),
        makeRow('reviews', 'Google Review Count', makeValue(data.reviewCount !== null && data.reviewCount !== undefined ? data.reviewCount.toLocaleString('en-US') : null, { mono: true })),
        makeRow('star', 'Google Rating', makeValue(data.rating !== null && data.rating !== undefined ? `${data.rating.toFixed(1)}/5` : null, { mono: true })),
        makeRow('globe', 'Website', makeValue(data.website, { link: true }))
      );
      card.append(header, list);
      resultList.appendChild(card);
    });
    outputText.textContent = records.map((data, index) => formatText(data, index + 1)).join('\n\n');
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function extract(url) {
    currentController = new AbortController();
    const response = await fetch('/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: currentController.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error((payload && payload.message) || 'Something went wrong while extracting this listing. Please try again.');
    return payload;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isRequestInFlight) return;
    const urls = [...new Set(urlInput.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean))];
    setError(null);
    if (!urls.length) { setError('Paste one or more Google Maps or Business Profile links first.'); urlInput.focus(); return; }
    if (urls.length > 25) { setError('Please extract up to 25 links at a time.'); return; }
    const invalidIndex = urls.findIndex((url) => !looksLikeMapsUrl(url));
    if (invalidIndex !== -1) { setError(`Link ${invalidIndex + 1} is not a Google Maps or Business Profile link.`); urlInput.focus(); return; }
    setLoading(true);
    const records = [];
    const failures = [];
    for (let index = 0; index < urls.length; index += 1) {
      try { records.push(await extract(urls[index])); }
      catch (error) { if (error.name === 'AbortError') return; failures.push(`${index + 1}) ${error.message}`); }
    }
    if (records.length) renderResults(records);
    if (failures.length) setError(`${failures.length} link${failures.length === 1 ? '' : 's'} could not be extracted: ${failures.join(' ')}`);
    if (!records.length && !failures.length) setError('No listings could be extracted.');
    setLoading(false);
  });

  urlInput.addEventListener('input', () => setError(null));
  clearBtn.addEventListener('click', () => { if (currentController) currentController.abort(); form.reset(); setError(null); setLoading(false); resultSection.hidden = true; resultList.replaceChildren(); urlInput.focus(); });
  copyBtn.addEventListener('click', () => { if (outputText.textContent) copyText(outputText.textContent, copyBtn); });
})();
