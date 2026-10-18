"use strict";

// ---------- transports (both deliver complete lines and accept text) ----------
const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX      = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write to ESP
const NUS_TX      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notifications from ESP

class LineSplitter {
  constructor(onLine) { this.buf = ""; this.onLine = onLine; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }
}

class BleTransport {
  kind = "ble";
  constructor(device, showAll = false, timeoutMs = 12000) { this.device = device ?? null; this.showAll = showAll; this.timeoutMs = timeoutMs; }   // known device: no search dialog
  async connect(onLine, onClose) {
    if (!this.device) {
      // showAll: no name filter, also lists devices that Windows already holds connected (they do not advertise a name)
      this.device = await navigator.bluetooth.requestDevice(this.showAll
        ? { acceptAllDevices: true, optionalServices: [NUS_SERVICE] }
        : { filters: [{ namePrefix: "VST-KIT" }], optionalServices: [NUS_SERVICE] });
    }
    this.device.addEventListener("gattserverdisconnected", onClose);
    const server = await Promise.race([
      this.device.gatt.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Zeitüberschreitung – Gerät nicht erreichbar")), this.timeoutMs)),
    ]);
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    const tx = await service.getCharacteristic(NUS_TX);
    const split = new LineSplitter(onLine);
    const dec = new TextDecoder();
    tx.addEventListener("characteristicvaluechanged", e => split.push(dec.decode(e.target.value)));
    await tx.startNotifications();
  }
  queue = Promise.resolve();                          // Web Bluetooth allows only one GATT write at a time
  send(text) {
    const job = this.queue.then(() => this._write(text));
    this.queue = job.catch(() => {});
    return job;
  }
  async _write(text) {
    const data = new TextEncoder().encode(text + "\n");
    for (let i = 0; i < data.length; i += 20) {      // 20 bytes = safe with default MTU
      await this.rx.writeValue(data.slice(i, i + 20));
    }
  }
  async close() { if (this.device?.gatt.connected) this.device.gatt.disconnect(); }
}

// USB-UART chips used on ESP32 boards: Silicon Labs CP210x, WCH CH340, FTDI, Espressif native USB
const ESP_USB_FILTERS = [{ usbVendorId: 0x10C4 }, { usbVendorId: 0x1A86 }, { usbVendorId: 0x0403 }, { usbVendorId: 0x303A }];

class SerialTransport {
  kind = "serial";
  constructor(port) { this.port = port ?? null; }
  async connect(onLine, onClose) {
    if (!this.port) this.port = await navigator.serial.requestPort({ filters: ESP_USB_FILTERS });
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.running = true;
    const split = new LineSplitter(onLine);
    this.loop = (async () => {
      const dec = new TextDecoder();
      try {
        while (this.running && this.port.readable) {
          this.reader = this.port.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await this.reader.read();
              if (done) break;
              split.push(dec.decode(value));
            }
          } finally { this.reader.releaseLock(); }
        }
      } catch (e) { /* port lost */ }
      if (this.running) onClose();
    })();
  }
  async send(text) { await this.writer.write(new TextEncoder().encode(text + "\n")); }
  async close() {
    this.running = false;
    try { await this.reader?.cancel(); } catch (e) {}
    try { await this.loop; } catch (e) {}              // reader must be released before the port can close
    try { this.writer.releaseLock(); await this.port.close(); } catch (e) {}
  }
}

// ---------- app ----------
const $ = id => document.getElementById(id);
const SENSORS = [["wheelsensor", "Lenkrad", "1"], ["gas1sensor", "Gas 1", "2"], ["gas2sensor", "Gas 2", "3"]];
const MAX_JSON = 950; // ESP parses into a 1024 byte JSON document

let transport = null;
let config = null;
let retryTimer = null;
let liveStarted = false;

function log(msg) {
  const el = $("log");
  el.textContent += msg + "\n";
  if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-10000);
  el.scrollTop = el.scrollHeight;
}
function setStatus(text, cls) { const s = $("status"); s.textContent = text; s.className = "status " + (cls || ""); }
function setInfo(text, cls) { const s = $("info"); s.textContent = text; s.className = "status " + (cls || ""); }

function buildSensorCards() {
  const host = $("sensors");
  for (const [key, title] of SENSORS) {
    const sec = document.createElement("section");
    sec.className = "card";
    sec.innerHTML = `<h2></h2><div class="grid">
      <label>Änderungsschwelle<input type="number" step="any" min="0" data-path="${key}.changeTreshhold"></label>
      <label>Orientierung<select data-path="${key}.sensorOrientation" data-type="int">
        <option value="0">0 – Z oben</option><option value="1">1 – Z vorne</option></select></label>
      <label>Winkel-Offset (°)<input type="number" step="any" data-path="${key}.angleoffset"></label>
      <label class="check"><input type="checkbox" data-path="${key}.multiTurn"> Multi-Turn</label></div>`;
    sec.querySelector("h2").textContent = title;
    host.appendChild(sec);
  }
}

function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, val) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = val;
}

function fillForm(cfg) {
  for (const el of $("form").querySelectorAll("[data-path]")) {
    const v = getPath(cfg, el.dataset.path);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
}

function readForm() {
  // start from the loaded config so unknown keys survive; "board" has to stay first
  const out = { board: {}, ...structuredClone(config ?? {}) };
  for (const el of $("form").querySelectorAll("[data-path]")) {
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "number" || el.dataset.type === "int") {
      v = Number(el.value);
      if (!Number.isFinite(v)) throw new Error("Ungültiger Wert bei " + el.dataset.path);
    } else v = el.value;
    setPath(out, el.dataset.path, v);
  }
  return out;
}

function onLine(line) {
  clearTimeout(answerTimer);
  if (line.startsWith("|")) {                         // live data |n:pitch;yaw;angle>
    const m = /^\|(\d):([-\d.]+);([-\d.]+);([-\d.]+)>/.exec(line);
    if (m && $("live" + m[1])) $("live" + m[1]).textContent = Number(m[4]).toFixed(1) + "°";
    return;
  }
  log("‹ " + line);
  if (line.startsWith("{")) {
    try {
      config = JSON.parse(line);
      fillForm(config);
      $("form").hidden = false;
      setInfo("Konfiguration geladen", "ok");
      send("board=getversion");
      send("board=getkey");
      if (transport?.kind === "ble" && !liveStarted) { liveStarted = true; send("board=livestart"); }
    } catch (e) { setInfo("Konfiguration konnte nicht gelesen werden", "err"); }
  } else if (line.startsWith("vstkit_")) {            // answer of board=getversion
    $("version").textContent = "Firmware: " + line;
    $("version").hidden = false;
    installedVersion = line;
    updateFwInfo();
  } else if (/^VST\d*-[\w-]+$/.test(line)) {           // answer of board=getkey
    $("key").textContent = "Key: " + line;
    $("key").hidden = false;
  } else if (line.startsWith("ERR:locked")) {
    if (!config) {
      setInfo("Gesperrt – VST-KIT in Windows koppeln, oder am Gerät BOOT-Taste 3 s halten (5-min-Fenster) …", "err");
      $("form").hidden = true;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => transport && send("board=getconfig"), 2500);  // retry until unlocked
    } else setInfo("Config-Fenster abgelaufen – BOOT-Taste erneut 3 s halten", "err");
  } else if (line.startsWith("SPIFFS:written")) {
    setInfo("Gespeichert", "ok");
  }
}

let answerTimer = null;
async function send(cmd) {
  if (cmd === "board=getconfig") {                  // warn if the ESP stays silent
    clearTimeout(answerTimer);
    answerTimer = setTimeout(() => { if (!config && transport) setInfo("Keine Antwort vom ESP – ist die neue Firmware geflasht und der Gamepad-Modus aktiv?", "err"); }, 4000);
  }
  log("› " + (cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd));
  try {
    await transport.send(cmd);
    log("  ✓ gesendet");
  } catch (e) {
    log("  ✗ Senden fehlgeschlagen: " + e.message);
    setInfo("Senden fehlgeschlagen: " + e.message, "err");
  }
}

async function connect(t) {
  try {
    setStatus("Verbinde …");
    await t.connect(onLine, () => onClosed());
    transport = t;
    $("btnBle").disabled = $("btnBleAll").disabled = $("btnSerial").disabled = true;
    $("btnDisconnect").disabled = false;
    setStatus("Verbunden (" + (t.kind === "ble" ? "Bluetooth" : "USB") + ")", "ok");
    $("liveCard").hidden = false;
    await send("board=getconfig");
    return true;
  } catch (e) {
    log("Fehler: " + e.message);
    setStatus(e.name === "NotFoundError" ? "Abgebrochen" : "Fehler: " + e.message, "err");
    try { await t.close(); } catch (_) {}
    transport = null;
    return false;
  }
}

// one click: use the device Chrome already knows, otherwise show the chooser
let lastBleDevice = null;   // kept in memory: reconnect after "Trennen" without the chooser
async function connectBle() {
  let known = lastBleDevice;
  if (!known) {
    try {
      const devices = navigator.bluetooth.getDevices ? await navigator.bluetooth.getDevices() : [];
      const vst = devices.filter(d => (d.name || "").startsWith("VST-KIT"));
      if (vst.length === 1) known = vst[0];
    } catch (e) { /* not supported */ }
  }
  if (known) {
    if (await connect(new BleTransport(known, false, 3000))) { lastBleDevice = known; return; }
    lastBleDevice = null;                                  // stale: fall back to the chooser
  }
  const t = new BleTransport();
  if (await connect(t)) lastBleDevice = t.device;
}

function onClosed() {
  transport = null; config = null; liveStarted = false; clearTimeout(retryTimer);
  $("btnBle").disabled = $("btnBleAll").disabled = !navigator.bluetooth;
  $("btnSerial").disabled = !navigator.serial;
  $("btnDisconnect").disabled = true;
  $("liveCard").hidden = true;
  $("version").hidden = true;
  $("key").hidden = true;
  installedVersion = null;
  updateFwInfo();
  setStatus("Getrennt");
}

$("btnBle").onclick = connectBle;
$("btnBleAll").onclick = () => connect(new BleTransport(null, true));
$("btnSerial").onclick = () => { setAutoUsb(true); showPortList(); };
async function disconnect() {
  if (!transport) return;
  const t = transport;
  if (t.kind === "serial") setAutoUsb(false);          // user disconnected USB on purpose: no auto connect next time
  try { if (t.kind === "ble") await send("board=livestop"); } catch (_) {}
  await t.close();
  onClosed();
}
$("btnDisconnect").onclick = disconnect;
$("btnReload").onclick = () => transport && send("board=getconfig");
$("btnReboot").onclick = async () => {
  if (!transport || !confirm("ESP neu starten? Die Verbindung wird getrennt.")) return;
  await send("board=reboot");
  setStatus("ESP startet neu – bitte neu verbinden");
};

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!transport) return;
  try {
    const json = JSON.stringify(readForm());
    if (json.length > MAX_JSON) throw new Error("Konfiguration zu groß (" + json.length + " Zeichen)");
    setInfo("Schreibe …");
    await send(json);
    config = JSON.parse(json);
    setInfo("Gesendet – Moduswechsel (Gamepad/Bluetooth) erst nach Neustart aktiv");
  } catch (err) { setInfo(err.message, "err"); }
});

$("btnExport").onclick = () => {
  try {
    const blob = new Blob([JSON.stringify(readForm(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "vstkit-config.json"; a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { setInfo(err.message, "err"); }
};
$("btnImport").onclick = () => $("fileImport").click();
$("fileImport").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { config = JSON.parse(await f.text()); fillForm(config); $("form").hidden = false; setInfo("Importiert – noch nicht auf den ESP geschrieben"); }
  catch (err) { setInfo("Ungültige JSON-Datei", "err"); }
};

try { if (localStorage.getItem("logOpen") === "0") $("logBox").open = false; } catch (e) {}
$("logBox").addEventListener("toggle", () => { try { localStorage.setItem("logOpen", $("logBox").open ? "1" : "0"); } catch (e) {} });

buildSensorCards();
const missing = [];
if (!navigator.bluetooth) { $("btnBle").disabled = true; missing.push("Web Bluetooth"); }
if (!navigator.serial) { $("btnSerial").disabled = true; missing.push("Web Serial"); }
if (missing.length) {
  $("support").hidden = false;
  $("support").textContent = "Nicht verfügbar in diesem Browser: " + missing.join(", ") + ". Bitte Chrome oder Edge verwenden (HTTPS oder localhost).";
}

// ---------- firmware update check ----------
let installedVersion = null;   // from board=getversion
let availableVersion = null;   // from firmware/version.json

function parseVersion(v) {
  const m = /^vstkit_(\d+)_(\d+(?:\.\d+)*)$/.exec(v || "");
  return m ? { hw: Number(m[1]), sw: m[2].split(".").map(Number) } : null;
}
function compareSw(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function updateFwInfo() {
  const el = $("fwInfo");
  const set = (text, cls) => { el.textContent = text; el.className = "status " + (cls || ""); };
  if (!availableVersion) return set("Keine Firmware-Datei auf dem Server gefunden.", "err");
  if (!installedVersion) return set("Verfügbar: " + availableVersion + " – installierte Version unbekannt (zum Vergleich verbinden).");

  const inst = parseVersion(installedVersion), avail = parseVersion(availableVersion);
  if (!inst || !avail) return set("Installiert: " + installedVersion + " · Verfügbar: " + availableVersion);
  if (inst.hw !== avail.hw) {
    return set("Achtung: andere Hardware-Version (Gerät " + inst.hw + ", Firmware " + avail.hw + ") – nicht installieren!", "err");
  }
  const d = compareSw(avail.sw, inst.sw);
  if (d > 0) {
    $("btnFlash").classList.add("primary");
    return set("Update verfügbar: " + installedVersion + " → " + availableVersion, "ok");
  }
  $("btnFlash").classList.remove("primary");
  if (d === 0) return set("Firmware ist aktuell (" + installedVersion + ")", "ok");
  set("Installierte Version (" + installedVersion + ") ist neuer als die veröffentlichte (" + availableVersion + ").");
}

async function loadAvailableVersion() {
  try {
    const r = await fetch("firmware/version.json", { cache: "no-store" });
    availableVersion = (await r.json()).version;
  } catch (e) { availableVersion = null; }
  updateFwInfo();
}

// the serial port has to be free for the flasher
$("fwInstall").addEventListener("click", () => { if (transport) disconnect(); }, true);
loadAvailableVersion();

// ---------- USB device list (shows the device name instead of the USB chip name) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let scanning = false;

// opens the port briefly and asks the firmware for its key and version
async function identifyPort(port, onProgress) {
  const info = { key: null, version: null, sawLive: false, error: null };
  const t = new SerialTransport(port);
  try {
    await t.connect(line => {
      if (/^VST\d*-[\w-]+$/.test(line)) info.key = line;
      else if (line.startsWith("vstkit_")) info.version = line;
      else if (line.startsWith("|")) info.sawLive = true;     // live data: VST-KIT firmware is running
    }, () => {});
    // opening the port resets the ESP; it needs several seconds to boot, so keep asking
    for (let i = 0; i < 20 && !(info.key && info.version); i++) {
      onProgress?.(i);
      await t.send("board=getkey");
      await t.send("board=getversion");
      await sleep(600);
    }
  } catch (e) {
    info.error = e.message;
  } finally {
    try { await t.close(); } catch (_) {}
  }
  return info;
}

function portLabel(port) {
  const i = port.getInfo();
  const hex = n => (n ?? 0).toString(16).padStart(4, "0").toUpperCase();
  return "USB " + hex(i.usbVendorId) + ":" + hex(i.usbProductId);
}

function addPortRow(port) {
  const row = document.createElement("div");
  row.className = "portrow";
  const text = document.createElement("span");
  text.textContent = "Suche … (" + portLabel(port) + ")";
  const btn = document.createElement("button");
  btn.textContent = "Verbinden";
  btn.disabled = true;
  btn.onclick = () => { $("portCard").hidden = true; connect(new SerialTransport(port)); };
  row.append(text, btn);
  $("portList").appendChild(row);
  return { text, btn };
}

async function scanPorts() {
  if (scanning) return;
  scanning = true;
  $("portList").textContent = "";
  try {
    const ports = (await navigator.serial.getPorts()).filter(p => ESP_USB_FILTERS.some(f => f.usbVendorId === p.getInfo().usbVendorId));
    if (!ports.length) {
      $("portList").textContent = "Noch kein Gerät freigegeben – „Gerät hinzufügen“ wählen und den ESP32 auswählen.";
      return;
    }
    const rows = ports.map(p => ({ port: p, ...addPortRow(p) }));
    for (const r of rows) {                                   // one after another
      const info = await identifyPort(r.port, i => { r.text.textContent = "Warte auf Start des ESP32 … " + (i * 0.6).toFixed(0) + " s (" + portLabel(r.port) + ")"; });
      if (info.key) {
        r.text.textContent = "VST-KIT-" + info.key.slice(-4) + (info.version ? " · " + info.version : "") + "  (" + portLabel(r.port) + ")";
        r.btn.textContent = "Verbinden";
      } else if (info.error) {
        r.text.textContent = "Port belegt oder nicht erreichbar (" + portLabel(r.port) + "): " + info.error;
        r.btn.textContent = "Trotzdem versuchen";
      } else if (info.sawLive) {
        r.text.textContent = "VST-KIT erkannt (Live-Daten), Key nicht gelesen (" + portLabel(r.port) + ")";
        r.btn.textContent = "Verbinden";
      } else {
        r.text.textContent = "ESP32 / USB-Gerät ohne VST-KIT-Antwort (" + portLabel(r.port) + ")";
        r.btn.textContent = "Trotzdem verbinden";
      }
      r.btn.disabled = false;
    }
  } finally { scanning = false; }
}

async function showPortList() {
  $("portCard").hidden = false;
  await scanPorts();
}
$("btnAddPort").onclick = async () => {
  try { await navigator.serial.requestPort({ filters: ESP_USB_FILTERS }); } catch (e) { return; }  // permission is remembered
  scanPorts();
};
$("btnRescan").onclick = () => scanPorts();
$("btnClosePorts").onclick = () => { $("portCard").hidden = true; };

// ---------- auto connect on page load (needs the browser to remember the permission) ----------
async function autoConnectBle() {
  try {
    if (!navigator.bluetooth?.getDevices) { log("Auto-Verbinden: getDevices() nicht verfügbar in diesem Browser"); return; }
    const all = await navigator.bluetooth.getDevices();
    log("Auto-Verbinden: " + all.length + " freigegebene Bluetooth-Geräte" + (all.length ? " (" + all.map(d => d.name || "ohne Namen").join(", ") + ")" : ""));
    const vst = all.filter(d => (d.name || "").startsWith("VST-KIT"));
    if (vst.length !== 1 || transport) return;
    if (await connect(new BleTransport(vst[0]))) lastBleDevice = vst[0];
    else setStatus("Nicht verbunden");                        // quiet: no error shown if the ESP is not in range
  } catch (e) { log("Auto-Verbinden Fehler: " + e.message); }
}
autoConnectBle();

// ---------- auto connect via USB on page load (Web Serial remembers granted ports) ----------
function autoUsbOff() { try { return localStorage.getItem("autoUsb") === "0"; } catch (e) { return false; } }
function setAutoUsb(on) { try { localStorage.setItem("autoUsb", on ? "1" : "0"); } catch (e) {} }

async function autoConnectSerial() {
  try {
    if (!navigator.serial || transport || autoUsbOff()) return;
    const ports = (await navigator.serial.getPorts()).filter(p => ESP_USB_FILTERS.some(f => f.usbVendorId === p.getInfo().usbVendorId));
    log("Auto-Verbinden USB: " + ports.length + " freigegebene(s) Gerät(e)");
    if (ports.length !== 1) return;
    await connect(new SerialTransport(ports[0]));
  } catch (e) { log("Auto-Verbinden USB Fehler: " + e.message); }
}
autoConnectSerial();
