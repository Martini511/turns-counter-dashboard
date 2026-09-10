/* XENSIV™ Turns Counter Dashboard
   Die Seite liest den seriellen Strom des Zählers und zeigt ihn an zwei
   Stellen: als Griff auf der dunklen Bühne und als Zahlen und Verläufe
   daneben. Geschrieben wird nur eine einzige Grösse – die Zeit, nach der
   der Sensor schlafen geht. */


(() => {
  "use strict";

  // ─── Protokoll ────────────────────────────────────────
  // Binärpakete tragen Strom, Klartextzeilen tragen Winkel und Antworten.
  // 0xA5 kommt in ASCII nicht vor und taugt deshalb als Sync-Byte.

  const SYNC0 = 0xa5;
  const SYNC1 = 0x5a;
  const PACKET_LENGTH = 7;
  const BAUD_RATE = 115200;

  const ADC_VREF_MV = 5000;
  const ADC_ZERO_MV = 2500;

  // ─── Masse der Anzeige ────────────────────────────────

  const ROLL_MS = 1200;        // Fenster der gleitenden Mittel- und Höchstwerte
  const GAP_MS = 250;          // längere Lücken werden nicht überzeichnet
  const SLEEP_IDLE_MS = 400;   // ohne Winkel gilt der Sensor als schlafend
  const SAFETY_CAP = 200000;   // harte Obergrenze der gespeicherten Punkte
  const LOG_LIMIT = 400;       // Zeilen im Protokollkasten

  // Der allererste Winkel nach dem Verbinden taugt nicht als Ruhelage. Beim
  // Öffnen des Anschlusses kommt zuerst, was im Gerät noch im Puffer stand -
  // Meldungen von vorhin, als der Griff womoeglich anders stand -, und der
  // Sensor braucht nach dem Aufwachen einen Augenblick, bis er trifft. Erst
  // eine Meldung nach dieser Frist wird zum Nullpunkt.
  const ZERO_SETTLE_MS = 500;

  // Das Modell des Türgriffs. Wo es liegt und wie weit sein Hebel schwenkt,
  // steht im Modell selbst. Der Pfad des Moduls ist von dieser Datei aus
  // gerechnet, der des Modells vom Dokument: So verlangt es der Browser.
  const MODEL_MODULE = "./model3d.js?v=13";
  const MODEL_URL = "./assets/models/xensiv_turns_counter.glb";

  // Solange das Modell nicht steht, gilt dieser Weg. Er ist derselbe, den das
  // Ausfuhrskript in die Datei schreibt.
  const HANDLE_TRAVEL = 67.31;                             // Grad

  // Farben der Bühne, damit die Leinwände dieselbe Sprache sprechen wie das
  // Stilblatt.
  const PALETTE = {
    grid: "#e7ebeb",
    axis: "#dfe4e4",
    text: "#6b7a7d",
    average: "#0a8a7c",
    peak: "#eb7000",
    angle: "#12a190",
    travel: "#12262b",
    // Schläft der Sensor, misst niemand. Der gehaltene Wert bekommt deshalb
    // ein Grau: Es ist kein Messwert, sondern der letzte, der noch gilt.
    asleep: "#9fb0b2",
  };

  const byId = (id) => document.getElementById(id);

  // ─── Bedienelemente ───────────────────────────────────

  const connectButton = byId("connect-button");
  const disconnectButton = byId("disconnect-button");
  const connectionLabel = byId("connection-label");
  const connectionText = byId("connection-text");
  const liveState = byId("live-state");
  const liveStateText = byId("live-state-text");
  const sleepInput = byId("sleep-ms");
  const setSleepButton = byId("set-sleep");
  const resetZeroButton = byId("reset-zero");
  const ackLabel = byId("ack");
  const windowSelect = byId("window-select");
  const pauseButton = byId("pause-button");
  const clearButton = byId("clear-button");
  const autoscroll = byId("autoscroll");
  const logBox = byId("log-box");

  const stageAngle = byId("stage-angle");
  const stageTravel = byId("stage-travel");
  const stageRate = byId("stage-rate");
  const dialValue = byId("dial-value");
  const dialArc = byId("dial-arc");
  const dialNeedle = byId("dial-needle-group");
  const sleepBadge = byId("sleep-badge");
  const handleStage = byId("handle-stage");
  const handleCanvas = byId("handle-canvas");

  const metricAngle = byId("metric-angle");
  const metricAverage = byId("metric-avg");
  const metricPeak = byId("metric-peak");
  const metricRollAverage = byId("metric-roll-avg");
  const metricRollMaximum = byId("metric-roll-max");
  const metricRate = byId("metric-rate");

  const currentCanvas = byId("current-chart");
  const angleCanvas = byId("angle-chart");
  const currentContext = currentCanvas.getContext("2d");
  const angleContext = angleCanvas.getContext("2d");
  const chartTabs = document.querySelectorAll(".chart-tab");
  const chartLegends = document.querySelectorAll(".chart-legend");

  // ─── Zustand ──────────────────────────────────────────

  let port = null;
  let reader = null;
  let writer = null;
  let keepReading = false;
  let overrunCount = 0;
  let lastOverrunLog = 0;

  let windowMs = 30000;
  let paused = false;   // friert die Sicht ein, die Daten laufen weiter
  let pausedAt = 0;
  let sensorSleeping = false;

  const viewNow = () => (paused ? pausedAt : performance.now());

  // Stromreihe (Mittel und Spitze) auf gemeinsamer Zeitachse.
  const currentTimes = [];
  const currentAverages = [];
  const currentPeaks = [];

  // Winkelreihe: was der Sensor misst, und was der Griff daraus macht.
  const angleTimes = [];
  const angleValues = [];
  const travelValues = [];

  // Gleitendes Fenster {t, average, maximum} und die Zeitpunkte der letzten
  // Sekunde für die Paketrate.
  const rolling = [];
  const rateStamps = [];

  // Protokollzeilen, die auf das nächste Bild warten.
  const pendingLog = [];

  // Umdrehungen zählt dieses Gerät nicht: Sein Hebel schwenkt aus der Ruhelage
  // bis an einen Anschlag und wieder zurück. Gezeigt wird deshalb, wie weit er
  // innerhalb dieses Weges steht – und das Modell schwenkt genauso weit mit.
  let model = null;
  let lastAngle = null;
  let travelLimit = HANDLE_TRAVEL;

  // Der Winkel, der als Ruhelage des Griffs gilt, und der Augenblick, seit dem
  // der Anschluss offen ist. Null ist ein gültiger Winkel, "noch keiner" ist
  // etwas anderes - deshalb null und nicht 0.
  let angleZero = null;
  let openedAt = 0;

  // ─── Bytestrom ────────────────────────────────────────

  const packet = new Uint8Array(PACKET_LENGTH);
  let packetIndex = 0;   // gesammelte Bytes eines Pakets, ab 2 nach dem Sync
  let sawSync0 = false;  // letztes Byte war 0xA5, 0x5A steht aus
  let asciiBuffer = "";

  // ─── Start ────────────────────────────────────────────

  buildDialTicks();
  updateHandle(null);
  drawCharts();
  loadModel();

  connectButton.addEventListener("click", connect);
  disconnectButton.addEventListener("click", () => disconnect("Connection released"));
  setSleepButton.addEventListener("click", sendSleepTimeout);
  resetZeroButton.addEventListener("click", resetZero);
  sleepInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendSleepTimeout();
  });
  clearButton.addEventListener("click", clearData);
  pauseButton.addEventListener("click", togglePause);
  for (const tab of chartTabs) {
    tab.addEventListener("click", () => showChart(tab.dataset.chart));
  }
  windowSelect.addEventListener("change", () => {
    windowMs = Number.parseInt(windowSelect.value, 10) * 1000;
  });
  window.addEventListener("resize", drawCharts);

  if (!("serial" in navigator)) {
    byId("unsupported").hidden = false;
    connectButton.disabled = true;
    setConnectionState("error", "Web Serial missing");
    setLiveState(false, "Web Serial not supported");
  } else {
    // Wird das Gerät abgezogen, endet die Verbindung von selbst.
    navigator.serial.addEventListener("disconnect", (event) => {
      if (port && event.target === port) disconnect("Device removed");
    });
  }

  requestAnimationFrame(frame);

  // ─── Verbindung ───────────────────────────────────────

  async function connect() {
    if (port) return;

    setConnectionState("searching", "Selecting port");
    setLiveState(false, "Waiting for port selection");

    try {
      port = await navigator.serial.requestPort();
      await port.open({
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        bufferSize: 8192,
      });
    } catch (error) {
      // Der Abbruch der Auswahl ist kein Fehler: Wer den Dialog schliesst,
      // will nicht verbinden und braucht dazu keine Meldung.
      port = null;
      const cancelled = error.name === "NotFoundError";
      setConnectionState(cancelled ? "offline" : "error",
        cancelled ? "Not connected" : "Connect failed");
      setLiveState(false, "Not connected");
      if (!cancelled) addLog(`[!]   Connect failed: ${error.message}`, "is-error");
      return;
    }

    writer = port.writable ? port.writable.getWriter() : null;
    keepReading = true;
    overrunCount = 0;

    // Jede Verbindung beginnt ohne Nullpunkt: Der erste Winkel setzt ihn.
    angleZero = null;
    openedAt = performance.now();

    connectButton.hidden = true;
    disconnectButton.hidden = false;
    setSleepButton.disabled = false;
    sleepInput.disabled = false;
    resetZeroButton.disabled = false;

    setConnectionState("online", `Connected · ${BAUD_RATE} baud`);
    setLiveState(true, "Reading serial stream");
    addLog(`[OK]  Port open at ${BAUD_RATE} baud`, "is-ok");

    readLoop();
    querySleepTimeout();
  }

  async function disconnect(reason) {
    if (!port) return;

    keepReading = false;
    try { if (reader) await reader.cancel(); } catch { /* schon geschlossen */ }
    try { if (writer) writer.releaseLock(); } catch { /* schon freigegeben */ }
    try { await port.close(); } catch { /* schon geschlossen */ }

    port = null;
    reader = null;
    writer = null;

    // Der Demultiplexer beginnt beim nächsten Verbinden sauber.
    packetIndex = 0;
    sawSync0 = false;
    asciiBuffer = "";
    sensorSleeping = false;
    angleZero = null;

    connectButton.hidden = false;
    disconnectButton.hidden = true;
    setSleepButton.disabled = true;
    sleepInput.disabled = true;
    resetZeroButton.disabled = true;

    setConnectionState("offline", "Not connected");
    setLiveState(false, "Not connected");
    addLog(`[!]   ${reason}`);
  }

  // Gelesen werden rohe Bytes, damit ein nicht tödlicher Fehler des Stroms –
  // etwa ein übergelaufener Puffer – aufgefangen und der Leser neu geholt
  // werden kann, ohne die Verbindung fallen zu lassen.
  async function readLoop() {
    while (keepReading && port && port.readable) {
      reader = port.readable.getReader();
      try {
        while (keepReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) ingest(value);
        }
      } catch (error) {
        overrunCount += 1;
        const now = performance.now();
        if (now - lastOverrunLog > 1000) {
          addLog(`[!]   ${error.message} (recovered, x${overrunCount})`, "is-error");
          setConnectionState("online", `Connected · overruns ${overrunCount}`);
          lastOverrunLog = now;
        }
        try { reader.releaseLock(); } catch { /* schon freigegeben */ }
        reader = null;
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      } finally {
        if (reader) {
          try { reader.releaseLock(); } catch { /* schon freigegeben */ }
        }
      }
    }
  }

  async function querySleepTimeout() {
    if (!writer) return;
    try {
      await writer.write(new TextEncoder().encode("T?\n"));
    } catch { /* die Antwort bleibt aus, mehr passiert nicht */ }
  }

  async function sendSleepTimeout() {
    if (!writer) return;

    const milliseconds = Number.parseInt(sleepInput.value, 10);
    if (!Number.isFinite(milliseconds) || milliseconds < 20 || milliseconds > 60000) {
      setAck("Enter 20 – 60000 ms", "is-error");
      return;
    }

    try {
      await writer.write(new TextEncoder().encode(`T${milliseconds}\n`));
      setAck(`Sent T${milliseconds} …`, "");
    } catch (error) {
      setAck(`Send failed: ${error.message}`, "is-error");
    }
  }

  // ─── Demultiplexer ────────────────────────────────────

  function ingest(bytes) {
    for (let index = 0; index < bytes.length; index += 1) processByte(bytes[index]);
  }

  function processByte(value) {
    if (packetIndex > 0) {
      packet[packetIndex] = value;
      packetIndex += 1;
      if (packetIndex === PACKET_LENGTH) {
        handlePacket(packet);
        packetIndex = 0;
      }
      return;
    }

    if (sawSync0) {
      sawSync0 = false;
      if (value === SYNC1) {
        packet[0] = SYNC0;
        packet[1] = SYNC1;
        packetIndex = 2;
        return;
      }
      // Ein einzelnes 0xA5 ist Rauschen: In ASCII kommt es nicht vor.
    }

    if (value === SYNC0) {
      sawSync0 = true;
      return;
    }

    if (value === 0x0a) {
      handleLine(asciiBuffer);
      asciiBuffer = "";
      return;
    }

    asciiBuffer += String.fromCharCode(value);
    if (asciiBuffer.length > 512) asciiBuffer = asciiBuffer.slice(-256);
  }

  function handlePacket(bytes) {
    const checksum = bytes[2] ^ bytes[3] ^ bytes[4] ^ bytes[5];
    if (checksum !== bytes[6]) return;   // beschädigtes Paket verfällt

    const maximumCounts = (bytes[2] << 8) | bytes[3];
    const averageCounts = (bytes[4] << 8) | bytes[5];
    pushCurrent(countsToMicroAmps(averageCounts), countsToMicroAmps(maximumCounts));
  }

  function handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) return;

    // Das Protokoll zeigt jede Zeile, die das Gerät schickt – auch die
    // Winkelzeilen. Was ausgewertet wird, steht daneben in den Messwerten.
    addLog(line, lineClass(line));

    // Kurze Winkelzeile "a<grad>", daneben die ältere Form "angle <grad> deg".
    const angleMatch = /^a(?:ngle\s+)?(-?\d+)(?:\s*deg)?$/i.exec(line);
    if (angleMatch) {
      pushAngle(Number.parseInt(angleMatch[1], 10));
      return;
    }

    if (/^OK\s+sleep/i.test(line)) {
      const milliseconds = /OK\s+sleep\s+(\d+)\s*ms/i.exec(line);
      // Das Feld folgt dem Gerät, nicht umgekehrt.
      if (milliseconds) sleepInput.value = milliseconds[1];
      setAck(line, "is-ok");
      return;
    }

    if (/^ERR\b/i.test(line)) {
      setAck(line, "is-error");
      return;
    }

    if (/sensor\s+SLEEP/i.test(line)) sensorSleeping = true;
  }

  function lineClass(line) {
    if (/^ERR\b/i.test(line)) return "is-error";
    if (/^OK\b/i.test(line)) return "is-ok";
    return "";
  }

  // Roher 12-Bit-Wert des Wandlers in Mikroampere. Die Umrechnung liegt hier
  // und nicht im Gerät: So bleibt der Strom über die Leitung unverfälscht.
  function countsToMicroAmps(counts) {
    const millivolts = (counts * ADC_VREF_MV) / 4096;
    return ((millivolts - ADC_ZERO_MV) * 100) / 30;
  }

  // ─── Messwerte ────────────────────────────────────────

  function pushCurrent(average, peak) {
    const now = performance.now();

    currentTimes.push(now);
    currentAverages.push(average);
    currentPeaks.push(peak);
    rolling.push({ t: now, average, maximum: peak });
    rateStamps.push(now);

    prune(now);

    metricAverage.textContent = formatMicroAmps(average);
    metricPeak.textContent = formatMicroAmps(peak);
    updateRolling(now);
  }

  function pushAngle(degrees) {
    const now = performance.now();
    sensorSleeping = false;

    angleTimes.push(now);
    angleValues.push(degrees);

    // Die erste Meldung nach der Einschwingfrist legt den Nullpunkt fest. Die
    // Winkel davor bekommen ihren Bezug nachträglich.
    if (angleZero === null && now - openedAt >= ZERO_SETTLE_MS) {
      angleZero = degrees;
      rebuildTravel();
      addLog(`[OK]  Handle zero set at ${degrees}°`, "is-ok");
    }

    // Ohne Nullpunkt gibt es noch keine Auslenkung. Die Reihe braucht
    // trotzdem einen Eintrag, sonst gerät sie gegen die Zeitachse aus dem
    // Tritt; sobald der Nullpunkt steht, holt `rebuildTravel` ihn nach.
    travelValues.push(angleZero === null ? 0 : handleSwing(degrees));

    prune(now);

    metricAngle.textContent = `${degrees}°`;
    updateHandle(degrees);
  }

  function updateRolling(now) {
    const start = now - ROLL_MS;
    while (rolling.length && rolling[0].t < start) rolling.shift();
    while (rateStamps.length && rateStamps[0] < now - 1000) rateStamps.shift();

    if (rolling.length) {
      let sum = 0;
      let maximum = -Infinity;
      for (const entry of rolling) {
        sum += entry.average;
        if (entry.maximum > maximum) maximum = entry.maximum;
      }
      metricRollAverage.textContent = formatMicroAmps(sum / rolling.length);
      metricRollMaximum.textContent = formatMicroAmps(maximum);
    }

    metricRate.textContent = `${rateStamps.length} /s`;
    stageRate.textContent = `${rateStamps.length} /s`;
  }

  function prune(now) {
    // Angehalten bleibt das eingefrorene Fenster erhalten; begrenzt wird nur
    // noch der Speicher.
    const start = paused ? -Infinity : now - windowMs;
    trim(currentTimes, [currentAverages, currentPeaks], start);
    trim(angleTimes, [angleValues, travelValues], start);
  }

  function trim(times, series, start) {
    let drop = 0;
    while (drop < times.length && times[drop] < start) drop += 1;
    if (times.length - drop > SAFETY_CAP) drop = times.length - SAFETY_CAP;
    if (drop === 0) return;

    times.splice(0, drop);
    for (const values of series) values.splice(0, drop);
  }

  function formatMicroAmps(value) {
    if (value === null || value === undefined) return "--";
    return `${Math.round(value)} µA`;
  }

  // ─── Bühne ────────────────────────────────────────────

  function buildDialTicks() {
    const ticks = byId("dial-ticks");
    const namespace = "http://www.w3.org/2000/svg";

    for (let degrees = 0; degrees < 360; degrees += 15) {
      const major = degrees % 90 === 0;
      const radians = ((degrees - 90) * Math.PI) / 180;
      const outer = 122;
      const inner = major ? 104 : 112;

      const line = document.createElementNS(namespace, "line");
      line.setAttribute("class", major ? "dial-tick is-major" : "dial-tick");
      line.setAttribute("x1", (160 + Math.cos(radians) * inner).toFixed(2));
      line.setAttribute("y1", (160 + Math.sin(radians) * inner).toFixed(2));
      line.setAttribute("x2", (160 + Math.cos(radians) * outer).toFixed(2));
      line.setAttribute("y2", (160 + Math.sin(radians) * outer).toFixed(2));
      ticks.append(line);

      if (!major) continue;

      // Die Beschriftung steht ausserhalb des Rings. Innen l\u00e4ge sie unter dem
      // Zeiger, und viermal je Umdrehung w\u00e4re sie nicht zu lesen.
      const label = document.createElementNS(namespace, "text");
      label.setAttribute("class", "dial-tick-label");
      label.setAttribute("x", (160 + Math.cos(radians) * 140).toFixed(2));
      label.setAttribute("y", (160 + Math.sin(radians) * 140).toFixed(2));
      label.textContent = String(degrees);
      ticks.append(label);
    }
  }

  // Das Modell löst die Zeichnung ab, sobald es steht. Es kommt nachträglich
  // dazu und nicht schon beim Laden der Seite: three.js ist ein Modul, und
  // Module verweigern sich einer Seite, die von der Festplatte kommt. Der
  // Rest der Seite – Verbindung, Messwerte, Verläufe – hängt damit nicht am
  // Modell und läuft auch dort, wo es nicht geladen werden kann.
  async function loadModel() {
    try {
      const { HandleModel } = await import(MODEL_MODULE);
      model = await new HandleModel(handleCanvas).load(MODEL_URL);
    } catch (error) {
      addLog(`[!]   3D model unavailable: ${error.message}`);
      return;
    }
    handleCanvas.hidden = false;
    handleStage.classList.add("has-model");
    travelLimit = model.limit;
    rebuildTravel();
    updateHandle(lastAngle);
  }

  // Beide Darstellungen zeigen denselben Winkel: die Zeichnung im vollen
  // Kreis, wie der Sensor ihn meldet, das Modell im Rahmen dessen, was die
  // Mechanik hergibt.
  function updateHandle(degrees) {
    lastAngle = degrees;

    if (degrees === null) {
      dialValue.textContent = "\u2013";
      dialNeedle.style.transform = "rotate(0deg)";
      dialArc.setAttribute("d", "");
      stageAngle.textContent = "\u2013";
      stageTravel.textContent = "\u2013";
      if (model) model.reset();
      return;
    }

    dialValue.textContent = `${degrees}\u00b0`;
    dialNeedle.style.transform = `rotate(${degrees}deg)`;
    dialArc.setAttribute("d", arcPath(degrees));
    stageAngle.textContent = `${degrees}\u00b0`;

    // Der Sensor misst absolut, der Griff nicht: Wo sein Magnet in der
    // Ruhelage steht, ist eine Frage der Montage. Der erste Winkel nach dem
    // Verbinden gilt deshalb als Null - der Griff wird losgelassen
    // angeschlossen. Solange keiner kam, gibt es keinen Nullpunkt und damit
    // auch keine Auslenkung zu zeigen.
    if (angleZero === null) {
      stageTravel.textContent = "–";
      return;
    }

    // Der Hebel steht in der Ruhelage oder irgendwo davor seinem Anschlag.
    // Ein Winkel jenseits der halben Umdrehung ist eine Auslenkung in die
    // Gegenrichtung und damit die Ruhelage – nicht der Anschlag.
    const swing = handleSwing(degrees);
    stageTravel.textContent =
      `${swing.toFixed(1)}° / ${travelLimit.toFixed(1)}°`;
    if (model) model.setAngle(degrees - angleZero);
  }

  function handleSwing(degrees) {
    return Math.min(Math.max(signedAngle(degrees - angleZero), 0), travelLimit);
  }

  // Die aufgezeichnete Auslenkung hängt am Nullpunkt. Verschiebt der sich, gilt
  // der neue rückwirkend: Der Verlauf zeigt den Griff, wie er zur jetzigen
  // Null steht, und nicht zu einer, die niemand mehr sieht.
  function rebuildTravel() {
    if (angleZero === null) {
      travelValues.length = 0;
      return;
    }
    for (let index = 0; index < angleValues.length; index += 1) {
      travelValues[index] = handleSwing(angleValues[index]);
    }
  }

  // Der kürzeste Weg zurück in den halben Kreis: 355 Grad sind fünf Grad in
  // die Gegenrichtung, nicht dreihundertfünfundfünfzig in diese.
  function signedAngle(degrees) {
    return ((degrees % 360) + 540) % 360 - 180;
  }

  // Der Griff wird auf den Winkel genullt, der gerade gilt – nicht auf den
  // nächsten, der hereinkommt. Zwischen dem Druck auf den Knopf und der
  // nächsten Meldung liegt eine Bewegung, und genau um die wäre der Nullpunkt
  // dann verschoben. Nur wenn noch gar nichts gemessen wurde, gibt es nichts
  // zu nehmen; dann setzt ihn die erste Meldung.
  function resetZero() {
    if (lastAngle === null) {
      angleZero = null;
      stageTravel.textContent = "–";
      if (model) model.reset();
      addLog("[OK]  Handle zero cleared, next reading sets it", "is-ok");
      return;
    }

    angleZero = lastAngle;
    rebuildTravel();
    updateHandle(lastAngle);
    addLog(`[OK]  Handle zero set at ${lastAngle}°`, "is-ok");
  }

  // Der Bogen läuft von der Null im Uhrzeigersinn bis zur aktuellen Stellung.
  // Ein grosser Bogen ist nötig, sobald mehr als ein Halbkreis zurückliegt.
  function arcPath(degrees) {
    if (degrees <= 0) return "";

    const radius = 96;
    const end = ((degrees - 90) * Math.PI) / 180;
    const largeArc = degrees > 180 ? 1 : 0;
    const x = (160 + Math.cos(end) * radius).toFixed(2);
    const y = (160 + Math.sin(end) * radius).toFixed(2);
    return `M 160 ${160 - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${x} ${y}`;
  }

  // Schlafend ist der Sensor, wenn er es selbst meldet – oder wenn seit der
  // letzten Winkelmeldung zu lange nichts kam.
  function isSleeping() {
    if (!port) return false;
    if (sensorSleeping) return true;
    return angleTimes.length > 0
      && performance.now() - angleTimes[angleTimes.length - 1] > SLEEP_IDLE_MS;
  }

  // ─── Verläufe ─────────────────────────────────────────

  // Gezeigt wird ein Verlauf, gezeichnet werden beide - der verborgene hat
  // keine Fläche, und `drawPlot` lässt ihn deshalb von selbst aus. So ist der
  // andere beim Umschalten sofort da, ohne dass hier etwas nachgeholt werden
  // müsste.
  function showChart(which) {
    for (const tab of chartTabs) {
      const chosen = tab.dataset.chart === which;
      tab.classList.toggle("is-active", chosen);
      tab.setAttribute("aria-selected", chosen ? "true" : "false");
    }
    for (const legend of chartLegends) {
      legend.toggleAttribute("hidden", legend.dataset.legend !== which);
    }
    currentCanvas.toggleAttribute("hidden", which !== "current");
    angleCanvas.toggleAttribute("hidden", which !== "angle");
    drawCharts();
  }

  function frame() {
    prune(viewNow());
    updateRolling(performance.now());   // die Messwerte bleiben auch angehalten aktuell
    // `hidden` als Eigenschaft kennt nur HTML; die Zeichnung ist SVG und
    // braucht das Attribut selbst.
    sleepBadge.toggleAttribute("hidden", !isSleeping());
    flushLog();
    drawCharts();
    requestAnimationFrame(frame);
  }

  function drawCharts() {
    drawPlot(currentCanvas, currentContext, currentTimes, [
      { data: currentPeaks, color: PALETTE.peak, width: 1.4 },
      { data: currentAverages, color: PALETTE.average, width: 1.8 },
    ], { fixed: false });
    drawPlot(angleCanvas, angleContext, angleTimes, [
      { data: angleValues, color: PALETTE.angle, width: 1.8 },
      { data: travelValues, color: PALETTE.travel, width: 1.8 },
    ], {
      fixed: true,
      minimum: 0,
      maximum: 360,
      // Schläft der Sensor, bricht die Linie nicht ab: Der Griff steht ja
      // weiter, wo er stand. Sie läuft waagerecht weiter und wechselt dabei
      // die Farbe – gemessen ist dieser Abschnitt nicht. Bis an den rechten
      // Rand reicht er nur, solange eine Verbindung besteht; ohne sie ist
      // nichts zu halten, sondern schlicht Schluss.
      holdColor: PALETTE.asleep,
      holdUntil: port ? viewNow() : null,
    });
  }

  // Zeichnet eine oder mehrere Reihen, die sich Zeitachse und Wertebereich
  // teilen. Die rechte Kante ist immer "jetzt".
  function drawPlot(canvas, context, times, series, options) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const padLeft = 52;
    const padRight = 12;
    const padTop = 12;
    const padBottom = 24;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;
    if (plotWidth <= 0 || plotHeight <= 0) return;

    const now = viewNow();
    const start = now - windowMs;

    let minimum;
    let maximum;
    if (options.fixed) {
      minimum = options.minimum;
      maximum = options.maximum;
    } else {
      let dataMaximum = 0;
      let dataMinimum = 0;
      for (const entry of series) {
        for (const value of entry.data) {
          if (value > dataMaximum) dataMaximum = value;
          if (value < dataMinimum) dataMinimum = value;
        }
      }
      maximum = niceStep(Math.max(dataMaximum, 10));
      minimum = dataMinimum < 0 ? -niceStep(-dataMinimum) : 0;
    }
    const range = maximum - minimum || 1;

    const xOf = (t) => padLeft + ((t - start) / windowMs) * plotWidth;
    const yOf = (v) => padTop + plotHeight - ((v - minimum) / range) * plotHeight;

    context.font = "10px 'IBM Plex Mono', monospace";
    context.lineWidth = 1;

    // Waagerechtes Raster mit Beschriftung.
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let index = 0; index <= 5; index += 1) {
      const value = minimum + (range * index) / 5;
      const y = Math.round(yOf(value)) + 0.5;
      context.strokeStyle = PALETTE.grid;
      context.beginPath();
      context.moveTo(padLeft, y);
      context.lineTo(width - padRight, y);
      context.stroke();
      context.fillStyle = PALETTE.text;
      context.fillText(Math.round(value).toString(), padLeft - 8, y);
    }

    // Senkrechtes Raster mit relativer Zeit; rechts steht die Null. Der
    // Schritt wird auf 1/2/5 gerundet, damit kurze Fenster nicht in lauter
    // gleiche Beschriftungen zerfallen.
    context.textAlign = "center";
    context.textBaseline = "top";
    const seconds = windowMs / 1000;
    const step = niceStep(seconds / 6);
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    for (let relative = 0; relative >= -seconds - 1e-9; relative -= step) {
      const x = Math.round(padLeft + ((relative + seconds) / seconds) * plotWidth) + 0.5;
      context.strokeStyle = PALETTE.grid;
      context.beginPath();
      context.moveTo(x, padTop);
      context.lineTo(x, padTop + plotHeight);
      context.stroke();
      context.fillStyle = PALETTE.text;
      context.fillText(
        relative === 0 ? "0s" : `${relative.toFixed(decimals)}s`,
        x,
        padTop + plotHeight + 6,
      );
    }

    context.strokeStyle = PALETTE.axis;
    context.beginPath();
    context.moveTo(padLeft + 0.5, padTop);
    context.lineTo(padLeft + 0.5, padTop + plotHeight + 0.5);
    context.lineTo(width - padRight, padTop + plotHeight + 0.5);
    context.stroke();

    context.save();
    context.beginPath();
    context.rect(padLeft, padTop, plotWidth, plotHeight);
    context.clip();

    for (const entry of series) {
      if (!entry.data.length) continue;

      // Erst das Gemessene. Über Lücken hebt der Stift ab: Zwischen zwei
      // Meldungen ist nichts gemessen, und eine Linie dort behauptete einen
      // Verlauf, den niemand gesehen hat.
      context.strokeStyle = entry.color;
      context.lineWidth = entry.width || 1.6;
      context.beginPath();

      let penDown = false;
      for (let index = 0; index < entry.data.length; index += 1) {
        if (index > 0 && times[index] - times[index - 1] > GAP_MS) penDown = false;
        const x = xOf(times[index]);
        const y = yOf(entry.data[index]);
        if (penDown) context.lineTo(x, y);
        else {
          context.moveTo(x, y);
          penDown = true;
        }
      }
      context.stroke();

      if (!options.holdColor) continue;

      // Dann das Gehaltene. Wo der Winkel gemeint ist, steht das Gerät auch
      // während des Schlafs irgendwo - der letzte Wert gilt weiter, bis ein
      // neuer kommt. Die Senkrechte am Ende sagt, dass er sich in dieser
      // Zeit geändert hat, ohne zu behaupten, wann.
      context.strokeStyle = options.holdColor;
      context.beginPath();

      for (let index = 1; index < entry.data.length; index += 1) {
        if (times[index] - times[index - 1] <= GAP_MS) continue;
        const held = yOf(entry.data[index - 1]);
        context.moveTo(xOf(times[index - 1]), held);
        context.lineTo(xOf(times[index]), held);
        context.lineTo(xOf(times[index]), yOf(entry.data[index]));
      }

      const last = entry.data.length - 1;
      if (options.holdUntil !== null
        && options.holdUntil - times[last] > GAP_MS) {
        const held = yOf(entry.data[last]);
        context.moveTo(xOf(times[last]), held);
        context.lineTo(xOf(options.holdUntil), held);
      }

      context.stroke();
    }

    context.restore();
  }

  // Rundet einen Rohschritt auf einen Wert der Form 1/2/5 × 10ⁿ, damit die
  // Achse gleichmässige Marken bekommt.
  function niceStep(value) {
    if (value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    const normalized = value / power;
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return step * power;
  }

  // ─── Werkzeuge ────────────────────────────────────────

  function togglePause() {
    paused = !paused;
    pausedAt = performance.now();
    pauseButton.textContent = paused ? "Resume" : "Pause";
    pauseButton.classList.toggle("is-active", paused);
  }

  function clearData() {
    currentTimes.length = 0;
    currentAverages.length = 0;
    currentPeaks.length = 0;
    angleTimes.length = 0;
    angleValues.length = 0;
    travelValues.length = 0;
    rolling.length = 0;
    rateStamps.length = 0;

    metricAngle.textContent = "--";
    metricAverage.textContent = "--";
    metricPeak.textContent = "--";
    metricRollAverage.textContent = "--";
    metricRollMaximum.textContent = "--";
    metricRate.textContent = "--";
    stageRate.textContent = "–";

    updateHandle(null);
    logBox.textContent = "";
    pendingLog.length = 0;
    setAck("", "");
  }

  // ─── Anzeigen ─────────────────────────────────────────

  function setConnectionState(state, text) {
    connectionLabel.dataset.state = state;
    connectionText.textContent = text;
  }

  function setLiveState(running, text) {
    liveState.classList.toggle("is-running", running);
    liveStateText.textContent = text;
  }

  function setAck(text, className) {
    ackLabel.textContent = text;
    ackLabel.className = className ? `ack ${className}` : "ack";
  }

  function addLog(text, className) {
    // Bei voller Rate kommen mehr Zeilen an, als ein Bild zeigen kann. Sie
    // warten deshalb, bis das nächste Bild sie gemeinsam einträgt – ein
    // Eintrag je Zeile hielte den Aufbau der Seite auf.
    pendingLog.push({ text, className });
    if (pendingLog.length > LOG_LIMIT) pendingLog.splice(0, pendingLog.length - LOG_LIMIT);
  }

  function flushLog() {
    if (!pendingLog.length) return;

    const batch = document.createDocumentFragment();
    for (const entry of pendingLog) {
      const line = document.createElement("div");
      // `textContent` statt `innerHTML`: Was das Gerät schickt, ist Text und
      // wird nie zu Markup.
      line.textContent = entry.text;
      if (entry.className) line.className = entry.className;
      batch.append(line);
    }
    pendingLog.length = 0;
    logBox.append(batch);

    while (logBox.childElementCount > LOG_LIMIT) logBox.firstElementChild.remove();
    if (autoscroll.checked) logBox.scrollTop = logBox.scrollHeight;
  }
})();
