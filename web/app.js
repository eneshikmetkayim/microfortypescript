/* MicroSIP TypeScript control panel — plain ES module, no build step. */

const $ = (selector) => document.querySelector(selector);
const numberInput = $("#number");
const eventsList = $("#events");
const historyBody = $("#history");
const callsBox = $("#calls");

const state = {
  status: null,
  calls: new Map(),
  history: [],
};

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
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatTime(epochSeconds) {
  if (!epochSeconds) return "-";
  const date = new Date(epochSeconds * 1000);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const time = date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}.${month} ${time}`;
}

function formatTimeFull(epochSeconds) {
  if (!epochSeconds) return "-";
  return new Date(epochSeconds * 1000).toLocaleString("tr-TR", { hour12: false });
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
  const text = pill.querySelector(".reg-text");
  if (text) text.textContent = label;
  else pill.textContent = label;

  const line = $("#lineState");
  if (line) {
    line.textContent =
      registration.state === "registered"
        ? `hat · kayıtlı · ${registration.expires}s`
        : registration.state === "failed"
          ? "hat · hata"
          : registration.state === "registering"
            ? "hat · kayıt oluyor"
            : "hat · kayıtsız";
  }
}

function renderAccount(status) {
  const account = status.account;
  $("#account").textContent = `${account.username || "-"}@${account.server || "-"} · ${account.transport} · ${account.label}`;
  $("#meta").textContent = [
    `codec    ${status.settings.audioCodecs}`,
    `tek mod  ${status.settings.singleMode ? "açık" : "kapalı"}`,
    `max hat  ${status.settings.maxConcurrentCalls}`,
    `plan     ${account.dialPlan || "yok"}`,
  ].join("\n");
}

function renderCalls() {
  const calls = [...state.calls.values()];
  $("#callCount").textContent = String(calls.length);
  if (!calls.length) {
    callsBox.innerHTML =
      '<div class="blank"><strong>Hat boş.</strong><span>Numarayı yazıp <em>Ara</em>\'ya basın. ' +
      "Gelen çağrı bu şeritte açılır; kayıt satırı çağrı kapandığında geçmişe düşer.</span></div>";
    syncControls();
    return;
  }
  callsBox.innerHTML = "";
  for (const call of calls) {
    const node = document.createElement("article");
    node.className = "call";
    node.dataset.state = call.state;
    const who = call.remoteDisplayName || call.remoteUser || call.remoteUri;
    node.innerHTML = `
      <header>
        <span class="who">${escapeHtml(who)}</span>
        <span class="state">${STATE_LABEL[call.state] ?? call.state}</span>
      </header>
      <div class="meta">
        <span>${call.direction === "in" ? "← gelen" : "→ giden"}</span>
        <span class="dur" data-start="${call.connectTime ?? 0}">${formatDuration(call.duration)}</span>
        ${call.codec ? `<span>${escapeHtml(call.codec)}</span>` : ""}
        ${call.held ? "<span>beklemede</span>" : ""}
        <span>${escapeHtml(call.remoteUri)}</span>
      </div>
      <div class="row">
        ${call.state === "early" && call.direction === "in" ? '<button data-act="answer">Cevapla</button>' : ""}
        <button data-act="hangup">Kapat</button>
        ${call.state === "confirmed" ? '<button data-act="hold">Beklet</button>' : ""}
      </div>`;
    node.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => act(button.dataset.act, call.id));
    });
    callsBox.append(node);
  }
  syncControls();
}

function syncControls() {
  const calls = [...state.calls.values()];
  const answered = calls.some((call) => call.state === "confirmed");
  const ringing = calls.some((call) => call.direction === "in" && call.state === "early");
  const active = calls.length > 0;
  $("#answer").disabled = !ringing;
  $("#hangup").disabled = !active;
  $("#hold").disabled = !answered;
  $("#transfer").disabled = !answered;
  $("#hangupAll").disabled = !active;
  $("#sendDtmf").disabled = !answered;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function renderHistory(rows) {
  state.history = rows;
  if (!rows.length) {
    historyBody.innerHTML = '<tr><td colspan="6" class="empty">Kayıt yok.</td></tr>';
    return;
  }
  historyBody.innerHTML = rows
    .map(
      (row) => `<tr>
        <td>${TYPE_LABEL[row.type] ?? row.type}</td>
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
  renderCalls();
  renderHistory(status.history);
}

async function act(action, callId) {
  try {
    if (action === "answer") await api("/api/answer", { callId });
    else if (action === "hangup") await api("/api/hangup", { callId });
    else if (action === "hold") await api("/api/hold", { callId });
  } catch (error) {
    log(`işlem hatası: ${error.message}`, "error");
  }
}

function appendDigit(digit) {
  numberInput.value += digit;
  numberInput.focus();
  syncControls();
}

numberInput.addEventListener("input", syncControls);

$("#pad").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (button) appendDigit(button.dataset.key);
});

numberInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("#call").click();
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

$("#answer").addEventListener("click", () => act("answer"));
$("#hangup").addEventListener("click", () => act("hangup"));
$("#hold").addEventListener("click", () => act("hold"));
$("#hangupAll").addEventListener("click", async () => {
  await api("/api/hangup-all", {});
  log("tüm çağrılar kapatıldı");
});

$("#sendDtmf").addEventListener("click", async () => {
  const digits = $("#dtmf").value.trim();
  if (!digits) return;
  try {
    await api("/api/dtmf", { digits });
    log(`DTMF gönderildi: ${digits}`);
    $("#dtmf").value = "";
  } catch (error) {
    log(`DTMF hatası: ${error.message}`, "error");
  }
});

$("#transfer").addEventListener("click", async () => {
  const target = window.prompt("Transfer hedefi (numara veya sip: URI)");
  if (!target) return;
  try {
    await api("/api/transfer", { target });
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
      void refreshHistory();
    } else {
      state.calls.set(call.id, call);
    }
    renderCalls();
  });
  source.addEventListener("incomingCall", (event) => {
    const call = JSON.parse(event.data);
    state.calls.set(call.id, call);
    renderCalls();
    log(`gelen çağrı: ${call.remoteDisplayName || call.remoteUser}`, "hook");
    document.title = `${call.remoteDisplayName || call.remoteUser} · gelen çağrı`;
  });
  source.addEventListener("hook", (event) => {
    const hook = JSON.parse(event.data);
    log(`hook: ${hook.command}`, "hook");
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
  source.onerror = () => {
    log("canlı bağlantı koptu, yeniden deneniyor…", "error");
  };
}

setInterval(() => {
  let changed = false;
  for (const call of state.calls.values()) {
    if (call.state === "confirmed") {
      call.duration += 1;
      changed = true;
    }
  }
  if (changed) renderCalls();
}, 1000);

function tickClock() {
  const now = new Date();
  $("#clock").textContent = now.toLocaleTimeString("tr-TR", { hour12: false });
  $("#metaLine").textContent =
    state.status && state.status.registration.state === "registered"
      ? `MicroSIP 3.23.5 · hatta · ${state.status.account.username}`
      : "MicroSIP 3.23.5 · yerel panel";
}
setInterval(tickClock, 1000);
tickClock();

loadStatus().then(connectEvents).catch((error) => {
  log(`panel yüklenemedi: ${error.message}`, "error");
});
