/* SchemeFinder — data, matching logic and rendering stay separate from the UI markup. */
const state = { schemes: [], allSchemes: [], matches: [], profile: null, category: "All", webSearchKey: "", webSearchRequestId: 0 };
const PIN_API_BASE = "https://api.zippopotam.us/in/";
const MATCH_WEIGHTS = { state: 30, occupation: 25, income: 20, education: 15, age: 10 };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupForm();
  $("#reset-form").addEventListener("click", resetForm);
  $("#search-web").addEventListener("click", searchWebForSchemes);
  $("#lookup-pincode").addEventListener("click", lookupPincode);
  $("#pincode").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      lookupPincode();
    }
  });
  $("#edit-profile").addEventListener("click", () => {
    $("#discover").scrollIntoView({ behavior: "smooth" });
    $("#state").focus();
  });
  $("#modal-close").addEventListener("click", closeModal);
  $("#scheme-modal").addEventListener("click", event => { if (event.target.id === "scheme-modal") closeModal(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeModal(); });
  loadSchemes();
  setupLibraryFilters();
});

function setupNavigation() {
  const toggle = $(".menu-toggle");
  const links = $("#main-menu");
  toggle.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);
  });
  $$("#main-menu a").forEach(link => link.addEventListener("click", () => links.classList.remove("open")));
}

async function loadSchemes() {
  let officialRecords = [];
  let usedLocalFallback = false;

  // A browser opened with file:// cannot fetch schemes.json. Use the embedded copy instead.
  if (location.protocol === "file:") {
    officialRecords = readEmbeddedSchemes();
    usedLocalFallback = true;
  } else {
    try {
      const response = await fetch("schemes.json");
      if (!response.ok) throw new Error("Scheme data could not be loaded.");
      officialRecords = await response.json();
    } catch (error) {
      officialRecords = readEmbeddedSchemes();
      usedLocalFallback = true;
      console.warn("Using embedded scheme data because schemes.json could not be fetched.", error);
    }
  }

  if (!officialRecords.length) {
    $(".form-card").insertAdjacentHTML("afterbegin", `<div class="error-banner" role="alert">Scheme data could not be loaded.</div>`);
    $("#profile-form").querySelector("button").disabled = true;
    return;
  }

  state.allSchemes = officialRecords.map(record => ({ ...record, verified: true }));
  state.schemes = state.allSchemes.filter(record => record.verified === true);
  renderLibrary();
  if (hasCompleteProfile(collectProfile())) {
    updateMatches(collectProfile(), false);
    $("#live-match-status").textContent = "Your related schemes have been updated below.";
  }

  if (usedLocalFallback) {
    $(".form-card").insertAdjacentHTML("afterbegin", `<div class="local-mode-note" role="status">Local mode: using the built-in scheme data. No web server is required.</div>`);
  }
}

function readEmbeddedSchemes() {
  return JSON.parse($("#embedded-scheme-data").textContent);
}

function setupForm() {
  const form = $("#profile-form");
  form.addEventListener("submit", event => {
    event.preventDefault();
    const profile = collectProfile();
    if (!validateProfile(profile)) return;
    updateMatches(profile, true);
  });

  // Keep the results in sync as soon as the required profile is complete.
  let liveMatchTimer;
  const updateLiveMatches = () => {
    window.clearTimeout(liveMatchTimer);
    liveMatchTimer = window.setTimeout(() => {
      const profile = collectProfile();
      if (!hasCompleteProfile(profile)) {
        $("#live-match-status").textContent = "Complete your profile to see related schemes automatically.";
        $("#results").hidden = true;
        return;
      }
      updateMatches(profile, false);
      $("#live-match-status").textContent = "Your related schemes have been updated below.";
    }, 180);
  };

  form.addEventListener("input", updateLiveMatches);
  form.addEventListener("change", updateLiveMatches);
}

function hasCompleteProfile(profile) {
  return Boolean(
    profile.state &&
    Number.isFinite(profile.age) &&
    profile.age >= 1 &&
    profile.age <= 120 &&
    profile.occupation &&
    profile.education &&
    Number.isFinite(profile.income) &&
    profile.income >= 0
  );
}

function updateMatches(profile, shouldScroll) {
  state.profile = profile;
  state.matches = state.schemes.map(scheme => ({ scheme, result: matchScheme(profile, scheme) }));
  renderResults(shouldScroll);
  autoSearchOfficialPages(profile);
}

function autoSearchOfficialPages(profile) {
  if (location.protocol === "file:") return;
  const searchKey = JSON.stringify(profile);
  if (state.webSearchKey === searchKey) return;
  state.webSearchKey = searchKey;
  searchWebForSchemes(true);
}

async function lookupPincode() {
  const input = $("#pincode");
  const status = $("#pincode-status");
  const button = $("#lookup-pincode");
  const pincode = input.value.trim();

  if (!/^\d{6}$/.test(pincode)) {
    status.textContent = "Enter a valid 6-digit PIN code.";
    status.className = "field-hint error";
    input.focus();
    return;
  }

  button.disabled = true;
  status.textContent = "Looking up your state…";
  status.className = "field-hint";

  try {
    const response = await fetch(`${PIN_API_BASE}${pincode}`);
    if (!response.ok) throw new Error("PIN lookup failed");
    const data = await response.json();
    const detectedState = data.places?.[0]?.state;
    if (!detectedState) throw new Error("State not found");

    const stateSelect = $("#state");
    let option = [...stateSelect.options].find(item => item.value.toLowerCase() === detectedState.toLowerCase());
    if (!option) {
      option = new Option(detectedState, detectedState);
      stateSelect.add(option);
    }
    stateSelect.value = option.value;
    stateSelect.removeAttribute("aria-invalid");
    $('[data-error="state"]').textContent = "";
    status.textContent = detectedState === "Assam"
      ? `Detected ${detectedState}. Your state field has been updated.`
      : `Detected ${detectedState}. This prototype focuses on Assam; All India schemes may still apply.`;
    status.className = "field-hint success";
  } catch (error) {
    status.textContent = "We couldn't look up that PIN code. Please select your state manually.";
    status.className = "field-hint error";
    console.error(error);
  } finally {
    button.disabled = false;
  }
}

function resetForm() {
  $("#profile-form").reset();
  $$(".field-error").forEach(field => field.textContent = "");
  $$("#profile-form [aria-invalid]").forEach(field => field.removeAttribute("aria-invalid"));
  $("#pincode-status").textContent = "Uses the public Zippopotam.us API. Your PIN code is not saved.";
  $("#pincode-status").className = "field-hint";
  $("#live-match-status").textContent = "Complete your profile to see related schemes automatically.";
  state.profile = null;
  state.matches = [];
  state.category = "All";
  state.webSearchKey = "";
  state.webSearchRequestId += 1;
  $("#web-results").hidden = true;
  $("#web-results").innerHTML = "";
  $("#results").hidden = true;
  $("#discover").scrollIntoView({ behavior: "smooth" });
}

function collectProfile() {
  const ageValue = $("#age").value.trim();
  const incomeValue = $("#income").value.trim();
  return {
    state: $("#state").value,
    age: ageValue === "" ? NaN : Number(ageValue),
    occupation: $("#occupation").value,
    education: $("#education").value,
    income: incomeValue === "" ? NaN : Number(incomeValue)
  };
}

function validateProfile(profile) {
  const errors = {};
  if (!profile.state) errors.state = "Please select a state.";
  if (!profile.age || profile.age < 1 || profile.age > 120) errors.age = "Enter an age between 1 and 120.";
  if (!profile.occupation) errors.occupation = "Please select an occupation.";
  if (!profile.education) errors.education = "Please select an education level.";
  if (Number.isNaN(profile.income) || profile.income < 0) errors.income = "Enter a valid annual income.";
  $$(".field-error").forEach(field => field.textContent = errors[field.dataset.error] || "");
  Object.keys(errors).forEach(key => $("#" + key).setAttribute("aria-invalid", "true"));
  ["state", "age", "occupation", "education", "income"].filter(key => !errors[key]).forEach(key => $("#" + key).removeAttribute("aria-invalid"));
  if (Object.keys(errors).length) {
    $("#" + Object.keys(errors)[0]).focus();
    return false;
  }
  return true;
}

function matchScheme(profile, scheme) {
  const e = scheme.eligibility;
  const hasAgeRule = e.min_age !== null || e.max_age !== null;
  const ageDetail = hasAgeRule
    ? `Age requirement: ${e.min_age === null ? "no minimum" : e.min_age}${e.max_age === null ? " or older" : `–${e.max_age}`}`
    : "The official record does not provide a general age range";
  const checks = [
    { key: "state", label: "State", points: MATCH_WEIGHTS.state, value: profile.state, result: scheme.state.includes(profile.state) || scheme.state.includes("All India"), detail: scheme.state.includes("All India") ? "Listed for all Indian states" : `Listed for ${scheme.state.join(", ")}` },
    { key: "age", label: "Age", points: MATCH_WEIGHTS.age, value: hasAgeRule ? profile.age : null, result: hasAgeRule && (e.min_age === null || profile.age >= e.min_age) && (e.max_age === null || profile.age <= e.max_age), detail: ageDetail },
    { key: "occupation", label: "Occupation", points: MATCH_WEIGHTS.occupation, value: e.occupations ? profile.occupation : null, result: e.occupations ? e.occupations.includes(profile.occupation) : false, detail: e.occupations ? `Accepted: ${e.occupations.join(", ")}` : "The official record does not provide a general occupation rule" },
    { key: "education", label: "Education", points: MATCH_WEIGHTS.education, value: e.education ? profile.education : null, result: e.education ? e.education.includes(profile.education) : false, detail: e.education ? `Accepted: ${e.education.join(", ")}` : "The official record does not provide a general education rule" },
    { key: "income", label: "Annual family income", points: MATCH_WEIGHTS.income, value: e.max_annual_income !== null ? profile.income : null, result: e.max_annual_income !== null && profile.income <= e.max_annual_income, detail: e.max_annual_income !== null ? `Maximum listed: ₹${e.max_annual_income.toLocaleString("en-IN")}` : "The official record does not provide a general income limit" }
  ];
  const conditions = checks.map(check => {
    const status = check.value === "" || check.value === null || check.value === undefined || Number.isNaN(check.value)
      ? "NEEDS_VERIFICATION"
      : check.result ? "MATCHED" : "NOT_MATCHED";
    return { ...check, status, score: status === "MATCHED" ? check.points : 0 };
  });
  const failed = conditions.some(condition => condition.status === "NOT_MATCHED");
  const pending = conditions.some(condition => condition.status === "NEEDS_VERIFICATION");
  return {
    status: failed ? "Not Matched" : pending ? "Needs Verification" : "Potential Match",
    score: conditions.reduce((total, condition) => total + condition.score, 0),
    conditions
  };
}

function renderResults(shouldScroll = true) {
  const results = $("#results");
  results.hidden = false;
  state.category = "All";
  const potential = state.matches.filter(match => match.result.status === "Potential Match").length;
  const needsVerification = state.matches.filter(match => match.result.status === "Needs Verification").length;
  const highestScore = state.matches.length ? Math.max(...state.matches.map(match => match.result.score)) : 0;
  $("#results-summary").textContent = `${potential} potential ${potential === 1 ? "match" : "matches"} found${needsVerification ? ` · ${needsVerification} ${needsVerification === 1 ? "needs" : "need"} verification` : ""}. Highest relevance: ${highestScore}/100.`;
  const categories = ["All", ...new Set(state.schemes.map(scheme => scheme.category))];
  $("#filters").innerHTML = categories.map(category => `<button class="filter ${category === "All" ? "active" : ""}" data-filter="${category}">${category === "All" ? "All schemes" : category}</button>`).join("");
  $$(".filter").forEach(button => button.addEventListener("click", () => {
    state.category = button.dataset.filter;
    $$(".filter").forEach(item => item.classList.toggle("active", item === button));
    renderCards();
  }));
  renderCards();
  if (shouldScroll) results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCards() {
  const statusPriority = { "Potential Match": 3, "Needs Verification": 2, "Not Matched": 1 };
  const visible = state.matches
    .filter(item => state.category === "All" || item.scheme.category === state.category)
    .sort((a, b) => statusPriority[b.result.status] - statusPriority[a.result.status] || b.result.score - a.result.score);
  const grid = $("#results-grid");
  if (!visible.length) {
    grid.innerHTML = `<div class="empty-state">No schemes in this category.</div>`;
    return;
  }
  grid.innerHTML = visible.map(({ scheme, result }) => {
    const statusClass = result.status === "Potential Match" ? "status-potential" : result.status === "Needs Verification" ? "status-verify" : "status-not";
    const source = safeOfficialUrl(scheme.source_url);
    const sourceMarkup = source ? `<a href="${source}" target="_blank" rel="noopener">${scheme.source_name}</a>` : `Source link unavailable (${scheme.source_name || "not provided"})`;
    return `<article class="scheme-card"><div class="scheme-card-top"><span class="scheme-category">${scheme.category}</span><span class="status-badge ${statusClass}">${result.status}</span></div><div class="relevance-score"><strong>${result.score}/100</strong> relevance score</div><h3>${scheme.name}</h3><p>${scheme.description}</p><ul class="benefit-list">${scheme.benefits.slice(0, 2).map(benefit => `<li>${benefit}</li>`).join("")}</ul><div class="scheme-source">Source: ${sourceMarkup}<br>Last verified: ${formatDate(scheme.last_verified)}</div><button class="details-button" data-id="${scheme.id}">View details <span>→</span></button></article>`;
  }).join("");
  $$(".details-button").forEach(button => button.addEventListener("click", () => openDetails(button.dataset.id)));
}

function openDetails(id) {
  const match = state.matches.find(item => item.scheme.id === id);
  if (!match) return;
  const { scheme, result } = match;
  const statusClass = result.status === "Potential Match" ? "status-potential" : result.status === "Needs Verification" ? "status-verify" : "status-not";
  const conditions = result.conditions.map(condition => {
    const pending = condition.status === "NEEDS_VERIFICATION";
    return `<div class="match-item ${pending ? "pending" : condition.result ? "matched" : "failed"}"><b>${pending ? "?" : condition.result ? "✓" : "×"}</b><span><strong>${condition.label}</strong> — ${pending ? "needs verification" : condition.result ? `matches (+${condition.points})` : "does not match the listed requirement"}<br><small>${condition.detail}</small></span></div>`;
  }).join("") + (scheme.eligibility.verification_note ? `<div class="verification-note">${scheme.eligibility.verification_note}</div>` : "");
  const sourceUrl = safeOfficialUrl(scheme.source_url);
  const applicationUrl = safeOfficialUrl(scheme.application_url);
  const officialActions = `<div class="official-actions">${sourceUrl ? `<a class="button button-primary" href="${sourceUrl}" target="_blank" rel="noopener">View official details ↗</a>` : `<span class="application-unavailable">Official source link unavailable</span>`}${applicationUrl ? `<a class="button button-secondary" href="${applicationUrl}" target="_blank" rel="noopener">Apply on official website ↗</a>` : `<span class="application-unavailable">Application link unavailable</span>`}</div>`;
  $("#modal-content").innerHTML = `<div class="scheme-category">${scheme.category} · ${scheme.state.join(", ")}</div><h2 id="modal-title">${scheme.name}</h2><span class="status-badge ${statusClass}">${result.status}</span><div class="modal-score"><strong>${result.score}/100</strong> relevance score</div><p class="modal-description">${scheme.description}</p><div class="detail-columns"><div><div class="detail-block"><h4>Why this result?</h4>${conditions}</div><div class="detail-block"><h4>Benefits</h4><ul>${scheme.benefits.map(item => `<li>${item}</li>`).join("")}</ul></div></div><div><div class="detail-block"><h4>Documents to prepare</h4><ul>${scheme.documents.map(item => `<li>${item}</li>`).join("")}</ul></div><div class="detail-block"><h4>Application process</h4><ul>${scheme.application_steps.map(item => `<li>${item}</li>`).join("")}</ul></div></div></div>${officialActions}<div class="official-note"><strong>Source:</strong> ${scheme.source_name}. Last verified: ${formatDate(scheme.last_verified)}. SchemeFinder links to official public information but is not connected to or operated by a government department.</div>`;
  $("#scheme-modal").hidden = false;
  $("#modal-close").focus();
  document.body.style.overflow = "hidden";
}

async function searchWebForSchemes(automatic = false) {
  const container = $("#web-results");
  const button = $("#search-web");
  if (!state.profile) {
    container.hidden = false;
    container.innerHTML = `<div class="web-message error">Submit your profile first so the search can use your information.</div>`;
    return;
  }

  if (automatic && location.protocol === "file:") return;

  button.disabled = true;
  button.textContent = "Searching official pages…";
  container.hidden = false;
  container.innerHTML = `<div class="web-message">Searching the web for relevant official government pages…</div>`;
  const requestId = ++state.webSearchRequestId;

  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: state.profile })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Web search failed.");
    if (requestId !== state.webSearchRequestId) return;
    renderWebResults(data);
  } catch (error) {
    if (requestId !== state.webSearchRequestId) return;
    container.innerHTML = `<div class="web-message error">${error.message}<br><small>Start the Python backend with <code>python backend/app.py</code>, then open <code>http://127.0.0.1:5000</code>.</small></div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Search web for schemes ↗";
  }
}

function renderWebResults(data) {
  const container = $("#web-results");
  if (!data.results?.length) {
    container.innerHTML = `<div class="web-message">No official government pages were found for this profile. Try a broader profile or verify the scheme name manually.</div>`;
    return;
  }
  const modeNote = data.api_configured ? "" : data.results.some(result => result.is_search_link)
    ? `<div class="web-message">Google returned a bot-check or limited response, so Python created a targeted search link instead.</div>`
    : `<div class="web-message">Results were fetched from Google’s public web search page. They are not verified scheme records.</div>`;
  container.innerHTML = `${modeNote}<div class="web-results-heading"><div><div class="eyebrow">LIVE WEB SEARCH · UNVERIFIED LINKS</div><h3>Official pages to review.</h3><p>${data.disclaimer} These links are separate from the verified scheme records above.</p></div><span class="search-provider">${data.provider}</span></div><div class="web-result-list">${data.results.map(result => `<article class="web-result-card"><div><div class="web-result-label">${result.is_search_link ? "Search link" : "Official web link · not a verified scheme record"}</div><h4>${result.title}</h4><p>${result.snippet || "No description was provided by the search provider."}</p><small><strong>Source department:</strong> ${result.source_department || "Official government source"}<br><strong>Website:</strong> ${result.source || "Not provided"}<br><strong>Application deadline:</strong> ${result.deadline || "Not stated — check the official notice"}</small></div><a class="button button-secondary" href="${result.link}" target="_blank" rel="noopener">${result.is_search_link ? "Open web search ↗" : "Open official page ↗"}</a></article>`).join("")}</div>`;
}

function setupLibraryFilters() {
  $("#library-search").addEventListener("input", renderLibrary);
  $("#library-state").addEventListener("change", renderLibrary);
}

function renderLibrary() {
  const query = $("#library-search").value.trim().toLowerCase();
  const selectedState = $("#library-state").value;
  const records = state.allSchemes.filter(scheme => scheme.verified === true && (!query || scheme.name.toLowerCase().includes(query)) && (!selectedState || scheme.state.includes(selectedState)));
  const grid = $("#library-grid");
  if (!records.length) {
    grid.innerHTML = `<div class="empty-state">No verified schemes match your search.</div>`;
    return;
  }
  grid.innerHTML = records.map(scheme => {
    const source = safeOfficialUrl(scheme.source_url);
    const application = safeOfficialUrl(scheme.application_url);
    return `<article class="library-card"><div class="scheme-card-top"><span class="scheme-category">${scheme.category || "Government scheme"}</span><span class="verified-badge">✓ Verified</span></div><h3>${scheme.name}</h3><p>${scheme.description}</p><div class="library-meta"><span>${scheme.state.join(", ")}</span><span>Verified ${formatDate(scheme.last_verified)}</span></div><div class="library-actions">${source ? `<a class="button button-secondary" href="${source}" target="_blank" rel="noopener">Official details ↗</a>` : ""}${application ? `<a class="button button-primary" href="${application}" target="_blank" rel="noopener">Apply officially ↗</a>` : `<span class="application-unavailable">Application link unavailable</span>`}</div></article>`;
  }).join("");
}

function safeOfficialUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const isGovernment = ["gov.in", "nic.in"].some(domain => parsed.hostname === domain || parsed.hostname.endsWith("." + domain));
    return parsed.protocol === "https:" && isGovernment ? parsed.href : null;
  } catch {
    return null;
  }
}

function formatDate(dateString) {
  if (!dateString) return "Not provided";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${dateString}T00:00:00Z`));
}

function closeModal() {
  $("#scheme-modal").hidden = true;
  document.body.style.overflow = "";
}
