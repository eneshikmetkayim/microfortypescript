/* MicroSIP TypeScript control panel — plain ES module, no build step. */

const $ = (selector) => document.querySelector(selector);
const numberInput = $("#number");
const eventsList = $("#events");
const historyBody = $("#history");
const callsBox = $("#calls");
const poolBox = $("#pool");
const setup = $("#setup");
const setupForm = $("#setupForm");
const setupNote = $("#setupNote");
const setupSave = $("#setupSave");

const TITLE = "microfort · operatör konsolu";
const state = { status: null, calls: new Map() };

const TYPE_LABEL = { 0: "giden", 1: "gelen", 2: "cevapsız", 3: "başka yerde" };
const STATE_LABEL = {
  idle: "boşta",
  calling: "aranıyor",
  early: "çalıyor",
  connecting: "bağlanıyor",
  confirmed: "konuşma",
  disconnected: "kapandı",
};

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function log(text, kind = "") {
  const item = document.createElement("li");
  if (kind) item.className = kind;
  const time = new Date().toLocaleTimeString("tr-TR", { hour12: false });
  item.textContent = `${time}  ${text}`;
  eventsList.prepend(item);
  while (eventsList.children.length > 120) eventsList.lastElementChild.remove();
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatWait(startedAt) {
  return formatDuration((Date.now() - startedAt) / 1000);
}

function formatTime(epochSeconds) {
  if (!epochSeconds) return "-";
  const date = new Date(epochSeconds * 1000);
  const time = date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")} ${time}`;
}

function formatTimeFull(epochSeconds) {
  if (!epochSeconds) return "-";
  return new Date(epochSeconds * 1000).toLocaleString("tr-TR", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function ringingCalls() {
  return [...state.calls.values()]
    .filter((call) => call.direction === "in" && call.state === "early")
    .sort((a, b) => a.startTime - b.startTime);
}

function liveCalls() {
  return [...state.calls.values()]
    .filter((call) => !(call.direction === "in" && call.state === "early"))
    .sort((a, b) => a.startTime - b.startTime);
}

function setRegistration(registration) {
  const pill = $("#registration");
  pill.dataset.state = registration.state;
  const label =
    registration.state === "registered"
      ? `kayıtlı · ${registration.expires}s`
      : registration.state === "registering"
        ? "kayıt oluyor"
        : registration.state === "failed"
          ? "hata"
          : "kayıtsız";
  pill.title = registration.reason ?? label;
  pill.querySelector(".reg-text").textContent = label;

  $("#lineState").textContent =
    registration.state === "registered"
      ? `hat · kayıtlı · ${registration.expires}s`
      : registration.state === "failed"
        ? "hat · hata"
        : registration.state === "registering"
          ? "hat · kayıt oluyor"
          : "hat · kayıtsız";
}

function renderAccount(status) {
  const account = status.account;
  $("#account").textContent =
    `${account.username || "-"}@${account.server || "-"} · ${account.transport} · ${account.label}`;
  $("#meta").textContent = [
    `codec    ${status.settings.audioCodecs}`,
    `tek mod  ${status.settings.singleMode ? "açık" : "kapalı"}`,
    `max hat  ${status.settings.maxConcurrentCalls}`,
    `plan     ${account.dialPlan || "yok"}`,
  ].join("\n");
}

function renderPool() {
  const queue = ringingCalls();
  $("#poolCount").textContent = String(queue.length);
  if (!queue.length) {
    poolBox.innerHTML = '<p class="pool-empty">Havuz boş. Çalan çağrılar sırayla burada bekler.</p>';
    return;
  }
  poolBox.innerHTML = queue
    .map((call, index) => {
      const who = call.remoteDisplayName || call.remoteUser || call.remoteUri;
      return `<article class="pool-item">
        <span class="pool-index">${String(index + 1).padStart(2, "0")}</span>
        <div class="pool-body">
          <div class="pool-line">
            <span class="pool-name">${escapeHtml(who)}</span>
            <span class="pool-wait">${formatWait(call.startTime)}</span>
          </div>
          <span class="pool-uri">${escapeHtml(call.remoteUri)}</span>
          <div class="pool-actions">
            <button data-act="answer" data-id="${escapeHtml(call.id)}">Cevapla</button>
            <button data-act="hangup" data-id="${escapeHtml(call.id)}">Reddet</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

function renderCalls() {
  const calls = liveCalls();
  $("#callCount").textContent = String(calls.length);
  if (!calls.length) {
    callsBox.innerHTML =
      '<div class="blank"><strong>Hat boş.</strong><span>Numarayı yazıp <em>Ara</em>\'ya basın. ' +
      "Çalan çağrılar önce havuza düşer; yanıtlanan çağrı burada süreyle açılır.</span></div>";
    return;
  }
  callsBox.innerHTML = calls
    .map((call) => {
      const who = call.remoteDisplayName || call.remoteUser || call.remoteUri;
      return `<article class="call" data-state="${call.state}">
        <header>
          <span class="who">${escapeHtml(who)}</span>
          <span class="state">${STATE_LABEL[call.state] ?? call.state}</span>
        </header>
        <div class="meta">
          <span>${call.direction === "in" ? "← gelen" : "→ giden"}</span>
          <span class="dur">${formatDuration(call.duration)}</span>
          ${call.codec ? `<span>${escapeHtml(call.codec)}</span>` : ""}
          ${call.held ? "<span>beklemede</span>" : ""}
          <span>${escapeHtml(call.remoteUri)}</span>
        </div>
        <div class="row">
          <button data-act="hangup" data-id="${escapeHtml(call.id)}">Kapat</button>
          ${call.state === "confirmed" ? `<button data-act="hold" data-id="${escapeHtml(call.id)}">Beklet</button>` : ""}
        </div>
      </article>`;
    })
    .join("");
}

function syncControls() {
  const ringing = ringingCalls();
  const live = liveCalls();
  const answered = live.find((call) => call.state === "confirmed");
  $("#answer").disabled = ringing.length === 0;
  $("#hangup").disabled = !live.length && !ringing.length;
  $("#hold").disabled = !answered;
  $("#transfer").disabled = !answered;
  $("#hangupAll").disabled = state.calls.size === 0;
  $("#sendDtmf").disabled = !answered;
}

function renderAll() {
  renderPool();
  renderCalls();
  syncControls();
}

function renderHistory(rows) {
  if (!rows.length) {
    historyBody.innerHTML = '<tr><td colspan="6" class="blank">Kayıt yok.</td></tr>';
    return;
  }
  historyBody.innerHTML = rows
    .map(
      (row) => `<tr>
        <td class="col-type">${TYPE_LABEL[row.type] ?? row.type}</td>
        <td>${escapeHtml(row.number)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${formatDuration(row.duration)}</td>
        <td title="${formatTimeFull(row.time)}">${formatTime(row.time)}</td>
        <td title="${escapeHtml(row.info)}">${escapeHtml(row.info)}</td>
      </tr>`,
    )
    .join("");
}

async function refreshHistory() {
  const { rows } = await api("/api/history?limit=50");
  renderHistory(rows);
}

async function loadStatus() {
  const status = await api("/api/status");
  state.status = status;
  state.calls = new Map(status.calls.map((call) => [call.id, call]));
  renderAccount(status);
  setRegistration(status.registration);
  renderAll();
  renderHistory(status.history);
}

async function act(action, callId) {
  const endpoints = { answer: "/api/answer", hangup: "/api/hangup", hold: "/api/hold" };
  const endpoint = endpoints[action];
  if (!endpoint) return;
  try {
    await api(endpoint, callId ? { callId } : {});
  } catch (error) {
    log(`işlem hatası: ${error.message}`, "error");
  }
}

function appendDigit(digit) {
  numberInput.value += digit;
  numberInput.focus();
  syncControls();
}

// ------------------------------------------------------------------- dialing

numberInput.addEventListener("input", syncControls);
numberInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#call").click();
});

$("#pad").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (button) appendDigit(button.dataset.key);
});

$("#call").addEventListener("click", async () => {
  const number = numberInput.value.trim();
  if (!number) {
    numberInput.focus();
    return;
  }
  try {
    const result = await api("/api/dial", { number });
    log(`arama başlatıldı: ${number} (${result.callId})`);
    numberInput.value = "";
  } catch (error) {
    log(`arama hatası: ${error.message}`, "error");
  }
});

// -------------------------------------------------------------- call actions

function wireActions(container) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (button) act(button.dataset.act, button.dataset.id);
  });
}
wireActions(poolBox);
wireActions(callsBox);

$("#answer").addEventListener("click", () => {
  const call = ringingCalls()[0];
  if (call) act("answer", call.id);
});
$("#hangup").addEventListener("click", () => {
  const call = liveCalls()[0] ?? ringingCalls()[0];
  if (call) act("hangup", call.id);
});
$("#hold").addEventListener("click", () => {
  const call = liveCalls().find((candidate) => candidate.state === "confirmed");
  if (call) act("hold", call.id);
});
$("#hangupAll").addEventListener("click", async () => {
  try {
    await api("/api/hangup-all", {});
    log("tüm çağrılar kapatıldı");
  } catch (error) {
    log(`kapatma hatası: ${error.message}`, "error");
  }
});

$("#sendDtmf").addEventListener("click", async () => {
  const digits = $("#dtmf").value.trim();
  if (!digits) return;
  const call = liveCalls().find((candidate) => candidate.state === "confirmed");
  try {
    await api("/api/dtmf", { digits, callId: call?.id });
    log(`DTMF gönderildi: ${digits}`);
    $("#dtmf").value = "";
  } catch (error) {
    log(`DTMF hatası: ${error.message}`, "error");
  }
});

$("#transfer").addEventListener("click", async () => {
  const target = window.prompt("Transfer hedefi (numara veya sip: URI)");
  if (!target) return;
  const call = liveCalls().find((candidate) => candidate.state === "confirmed");
  try {
    await api("/api/transfer", { target, callId: call?.id });
    log(`transfer istendi: ${target}`);
  } catch (error) {
    log(`transfer hatası: ${error.message}`, "error");
  }
});

$("#refreshHistory").addEventListener("click", () => {
  void refreshHistory().catch((error) => log(`geçmiş hatası: ${error.message}`, "error"));
});

$("#clearLog").addEventListener("click", () => {
  eventsList.innerHTML = "";
});

// --------------------------------------------------------------------- setup

function fillSetup(config) {
  const form = setupForm.elements;
  const values = {
    label: config.account.label,
    server: config.account.server,
    username: config.account.username,
    displayName: config.account.displayName,
    dialPlan: config.account.dialPlan,
    transport: config.account.transport,
    maxConcurrentCalls: config.settings.maxConcurrentCalls,
  };
  for (const [name, value] of Object.entries(values)) {
    const field = form.namedItem(name);
    if (field) field.value = value ?? "";
  }
  const password = form.namedItem("password");
  password.value = "";
  password.placeholder = config.account.hasPassword ? "kayıtlı · boş bırak" : "parola";

  setupSave.disabled = !config.editable;
  setupNote.classList.remove("error");
  setupNote.textContent = config.editable
    ? `Hesap ${config.account.id} · ${config.iniPath} · parola düz metin olarak ini dosyasına yazılır.`
    : "Bu oturumda ini dosyası düzenlenemiyor.";
}

async function openSetup() {
  try {
    fillSetup(await api("/api/config"));
    setup.showModal();
  } catch (error) {
    log(`kurulum yüklenemedi: ${error.message}`, "error");
  }
}

$("#openSetup").addEventListener("click", openSetup);
$("#setupClose").addEventListener("click", () => setup.close());
$("#setupCancel").addEventListener("click", () => setup.close());
setup.addEventListener("click", (event) => {
  if (event.target === setup) setup.close();
});

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(setupForm));
  data.maxConcurrentCalls = Number(data.maxConcurrentCalls);
  setupSave.disabled = true;
  try {
    const result = await api("/api/config", data);
    setup.close();
    log(result.restartRequired ? "kurulum kaydedildi · hat yeniden bağlanıyor" : "kurulum kaydedildi");
    if (result.restartError) log(`yeniden bağlanma hatası: ${result.restartError}`, "error");
    await loadStatus();
  } catch (error) {
    setupNote.textContent = error.message;
    setupNote.classList.add("error");
  } finally {
    setupSave.disabled = false;
  }
});

// ---------------------------------------------------------------------- live

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => log("olay şeridi bağlandı"));
  source.addEventListener("registration", (event) => {
    const registration = JSON.parse(event.data);
    setRegistration(registration);
    log(`kayıt durumu: ${registration.state}${registration.reason ? ` (${registration.reason})` : ""}`);
  });
  source.addEventListener("call", (event) => {
    const call = JSON.parse(event.data);
    if (call.state === "disconnected") {
      state.calls.delete(call.id);
      log(`çağrı kapandı: ${call.remoteUser} · ${call.reason ?? ""} · ${formatDuration(call.duration)}`);
      void refreshHistory().catch(() => undefined);
      if (!state.calls.size) document.title = TITLE;
    } else {
      state.calls.set(call.id, call);
    }
    renderAll();
  });
  source.addEventListener("incomingCall", (event) => {
    const call = JSON.parse(event.data);
    state.calls.set(call.id, call);
    renderAll();
    log(`gelen çağrı: ${call.remoteDisplayName || call.remoteUser}`, "hook");
    document.title = `${call.remoteDisplayName || call.remoteUser} · gelen çağrı`;
  });
  source.addEventListener("hook", (event) => {
    log(`hook: ${JSON.parse(event.data).command}`, "hook");
  });
  source.addEventListener("history", (event) => {
    renderHistory(JSON.parse(event.data));
  });
  source.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    log(`mesaj (${message.from}): ${message.body}`);
  });
  source.addEventListener("error", (event) => {
    if (event.data) log(`hata: ${JSON.parse(event.data).message}`, "error");
  });
  source.onerror = () => log("canlı bağlantı koptu, yeniden deneniyor…", "error");
}

function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("tr-TR", { hour12: false });
  $("#metaLine").textContent =
    state.status?.registration.state === "registered"
      ? `MicroSIP 3.23.5 · hatta · ${state.status.account.username}`
      : "MicroSIP 3.23.5 · yerel panel";
}

setInterval(() => {
  tickClock();
  if (!state.calls.size) return;
  let changed = false;
  for (const call of state.calls.values()) {
    if (call.state === "confirmed") {
      call.duration += 1;
      changed = true;
    }
  }
  if (changed || ringingCalls().length) renderAll();
}, 1000);
tickClock();

loadStatus().then(connectEvents).catch((error) => {
  log(`panel yüklenemedi: ${error.message}`, "error");
});
