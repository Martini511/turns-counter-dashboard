/* XENSIV™ Turns Counter Dashboard
   Die Seite liest den seriellen Strom des Zählers und zeigt ihn an zwei
   Stellen: als Türgriff oder Lenkrad auf der dunklen Bühne und als Zahlen
   und Verläufe daneben. Geschrieben wird nur eine einzige Grösse – die Zeit,
   nach der der Sensor schlafen geht. */


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
  const STEM_DOT = 1.5;        // Kopf der Senkrechten im Schlaf, in Pixeln

  // Der allererste Winkel nach dem Verbinden taugt nicht als Ruhelage. Beim
  // Öffnen des Anschlusses kommt zuerst, was im Gerät noch im Puffer stand -
  // Meldungen von vorhin, als der Griff womoeglich anders stand -, und der
  // Sensor braucht nach dem Aufwachen einen Augenblick, bis er trifft. Erst
  // eine Meldung nach dieser Frist wird zum Nullpunkt.
  const ZERO_SETTLE_MS = 500;

  // Der Pfad des Moduls ist von dieser Datei aus gerechnet, die der Modelle
  // vom Dokument: So verlangt es der Browser.
  const MODEL_MODULE = "./model3d.js?v=24";

  // ─── Demos ────────────────────────────────────────────
  // Dasselbe Zählermodul steckt in zwei Aufbauten. Beide funktionieren gleich,
  // nur zählt der eine Grad und der andere Umdrehungen:
  //
  // "swing"  Der Türgriff schwenkt aus der Ruhelage bis an seinen Anschlag.
  //          Gezeigt wird, wie weit er innerhalb dieses Weges steht.
  // "turns"  Das Lenkrad dreht frei, beliebig oft in beide Richtungen.
  //          Gezeigt werden die Umdrehungen seit der Null.
  //
  // Der Steckbrief `rig` sagt dem Modell, was sich bewegt: die Bauteile mit
  // diesen Namensanfängen. Die Achse liest es aus der Geometrie der Welle,
  // die Drehrichtung aus `positive` (siehe model3d.js). `mount` ist die
  // Halterung, in der beide Demos stecken; in ihren Koordinaten gelten auch
  // die Blickrichtungen `home` und die Richtungen der Logos. `finish` färbt
  // Bauteile um, `logos` die eingravierten Logos. Die Namen stammen aus der
  // Konstruktion; wer dort umbenennt, muss es hier nachtragen.
  // Die Farben aus dem CAD sind Grau in Grau, und die dunkle Bühne schluckt
  // den Rest. Deshalb hier eine eigene Ordnung, die in beiden Demos gilt:
  // Was sich bewegt, ist das Hellste auf der Bühne; der Sockel darunter
  // dunkel, damit sich beides trennt; die Halterung hell und kühl, damit sie
  // auch leer für sich steht. Das eingravierte Logo trägt das Blau aus dem
  // Infineon-Zeichen - Blau auf Weiss, wie im Original.
  const FINISH = {
    moving: { color: "#f4f6f7", roughness: 0.38, metalness: 0 },
    socket: { color: "#3d474c", roughness: 0.55, metalness: 0 },
    holder: { color: "#c7d1d5", roughness: 0.6, metalness: 0 },
  };
  const LOGO_BLUE = "#165ca8";

  const DEMOS = {
    handle: {
      kind: "swing",
      rig: {
        url: "./assets/models/Cardoor_handle_demo_v_3.glb",
        up: "z",
        mount: "Add_on_holder_plate",
        axis: "Axis",
        moving: ["Handle_v", "Magnet_0603"],
        positive: "lift",
        travel: 67.31,                                     // Grad, aus der Konstruktion
        home: { azimuth: -0.72, polar: 1.04 },
        finish: {
          Handle_v: FINISH.moving,
          Base_with_PCB: FINISH.socket,
          Add_on_holder_plate: FINISH.holder,
        },
        logos: [
          { part: "Handle_v", facing: [0, 0, 1], color: LOGO_BLUE },
          // Die Stirnseite des Sockels trägt ein zweites, kleineres Logo.
          // Blau auf Anthrazit ginge unter; dort steht es hell.
          { part: "Base_with_PCB", facing: [0, -1, 0], color: FINISH.moving.color },
        ],
      },
      text: {
        name: "Door handle",
        title: "Handle and wake-up current",
        travel: "HANDLE TRAVEL",
        metric: "ANGLE",
        metricUnit: "degrees",
        chart: "ANGLE \u00b7 DEGREES",
        reset: "Reset Handle Angle",
        resetTitle: "Take the current reading as the handle's rest position",
        model: "Model of the XENSIV turns counter door handle",
        hint: "Connect the counter over USB; the page reads its serial stream at "
          + "115200 baud. Shortly after connecting the angle then read counts as "
          + "the handle's rest position \u2013 connect with the handle released, or "
          + "press \u201cReset Handle Angle\u201d to take the reading of that moment "
          + "as the new zero.",
      },
    },
    wheel: {
      kind: "turns",
      rig: {
        url: "./assets/models/Steering_wheel_demo_v_1.glb",
        up: "z",
        mount: "Add_on_holder_plate",
        axis: "Axis_v",
        moving: ["Steering_wheel_", "Axis_v", "Magnet_holder", "Magnet_0603"],
        positive: "clockwise",
        travel: Infinity,
        // Schräg von der Seite: Das Rad bleibt als Rad lesbar, und hinter ihm
        // sind Lenksäule, Magnet und Platine zu sehen - um die geht es ja.
        home: { azimuth: -2.87, polar: 0.9 },
        finish: {
          Steering_wheel_: FINISH.moving,
          Steering_base: FINISH.socket,
          Add_on_holder_plate: FINISH.holder,
        },
        // Das Logo sitzt auf der Nabe und schaut zum Fahrer.
        logos: [{ part: "Steering_wheel_front", facing: "out", color: LOGO_BLUE }],
      },
      text: {
        name: "Steering wheel",
        title: "Steering wheel and wake-up current",
        travel: "ROTATION",
        metric: "TURNS",
        metricUnit: "revolutions",
        chart: "TURNS \u00b7 REVOLUTIONS",
        reset: "Reset Turns",
        resetTitle: "Take the current wheel position as zero turns",
        model: "Model of the XENSIV turns counter steering wheel",
        hint: "Connect the counter over USB; the page reads its serial stream at "
          + "115200 baud. Shortly after connecting the wheel's position then read "
          + "counts as zero turns. Turning right counts up, turning left counts "
          + "down, without an end stop. Press \u201cReset Turns\u201d to count from "
          + "the current position.",
      },
    },
  };

  // Bis die Firmware selbst sagt, in welchem Aufbau sie steckt, wählt ein
  // Schalter in der Kopfzeile die Demo. Die Wahl übersteht ein Neuladen.
  // Meldet sich das Gerät mit einer Zeile "demo <name>", gilt dessen Angabe;
  // diese Namen versteht die Seite dabei.
  const DEMO_STORAGE_KEY = "turns-counter-demo";
  const DEMO_NAMES = {
    handle: "handle", door: "handle", doorhandle: "handle",
    wheel: "wheel", steering: "wheel", steeringwheel: "wheel",
  };

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
  const orientationSelect = byId("orientation");
  const resetZeroButton = byId("reset-zero");
  const ackLabel = byId("ack");
  const windowSelect = byId("window-select");
  const pauseButton = byId("pause-button");
  const clearButton = byId("clear-button");

  const stageAngle = byId("stage-angle");
  const stageTravel = byId("stage-travel");
  const stageTravelLabel = byId("stage-travel-label");
  const stageTurns = byId("stage-turns-value");
  const stageRate = byId("stage-rate");
  const dialValue = byId("dial-value");
  const dialCaption = byId("dial-caption");
  const dialArc = byId("dial-arc");
  const dialNeedle = byId("dial-needle-group");
  const sleepBadge = byId("sleep-badge");
  const handleStage = byId("handle-stage");
  const handleCanvas = byId("handle-canvas");

  const demoSwitch = byId("demo-switch");
  const demoPicks = document.querySelectorAll("[data-demo-pick]");
  const demoOnly = document.querySelectorAll("[data-only]");
  const pageTitle = byId("page-title");
  const hint = byId("hint");

  const metricAngle = byId("metric-angle");
  const metricAngleLabel = byId("metric-angle-label");
  const metricAngleUnit = byId("metric-angle-unit");
  const angleChartTitle = byId("angle-chart-title");
  const metricAverage = byId("metric-avg");
  const metricPeak = byId("metric-peak");
  const metricRollAverage = byId("metric-roll-avg");
  const metricRollMaximum = byId("metric-roll-max");
  const metricRate = byId("metric-rate");
  const sleepingCards = document.querySelectorAll(".metric-card[data-sleeps]");

  const currentCanvas = byId("current-chart");
  const angleCanvas = byId("angle-chart");
  const currentContext = currentCanvas.getContext("2d");
  const angleContext = angleCanvas.getContext("2d");

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

  // Stromreihe (Mittel und Spitze) auf gemeinsamer Zeitachse. Dazu je Punkt
  // die Notiz, ob der Sensor beim Messen schlief: Gezeichnet wird ein solcher
  // Punkt nicht als Teil eines Linienzugs, sondern für sich.
  const currentTimes = [];
  const currentAverages = [];
  const currentPeaks = [];
  const currentAsleep = [];

  // Winkelreihe: was der Sensor misst, derselbe Winkel ohne Sprung an der
  // vollen Umdrehung, und was die Demo daraus macht - beim Griff die
  // Auslenkung in Grad, beim Lenkrad die Umdrehungen.
  const angleTimes = [];
  const angleValues = [];
  const unwrappedValues = [];
  const travelValues = [];

  // Gleitendes Fenster {t, average, maximum} und die Zeitpunkte der letzten
  // Sekunde für die Paketrate.
  const rolling = [];
  const rateStamps = [];

  // Zeilen der CSV-Datei gibt es nicht mehr; was gemessen wird, steht in den
  // Reihen oben.

  // Welche Demo gerade läuft, und ob das Gerät selbst sie bestimmt hat. Dann
  // schweigt der Schalter, bis die Verbindung endet.
  let demoId = readStoredDemo();
  let demo = DEMOS[demoId];
  let demoFromDevice = false;

  // Der Griff schwenkt aus der Ruhelage bis an einen Anschlag und wieder
  // zurück; gezeigt wird, wie weit er innerhalb dieses Weges steht. Das
  // Lenkrad hat keinen Anschlag, sein Weg ist unendlich.
  let model = null;
  let lastAngle = null;
  let travelLimit = demo.rig.travel;

  // Der Sensor meldet den Winkel im vollen Kreis; nach 359 kommt 0. Die
  // Umdrehungen ergeben sich erst, wenn jeder Schritt als der kürzere Weg
  // vom vorigen Winkel gelesen wird. Dieser Wert läuft deshalb ohne Sprung
  // weiter, über beliebig viele Umdrehungen und auch über ein Leeren der
  // Verläufe oder eine neue Verbindung hinweg. Verloren geht eine Umdrehung
  // nur, wenn sich das Rad zwischen zwei Meldungen um mehr als eine halbe
  // gedreht hat.
  let lastUnwrapped = null;

  // Der Winkel, der als Ruhelage des Griffs gilt, und der Augenblick, seit dem
  // der Anschluss offen ist. Null ist ein gültiger Winkel, "noch keiner" ist
  // etwas anderes - deshalb null und nicht 0. Die Null des Lenkrads ist
  // derselbe Augenblick, gemessen am durchlaufenden Winkel.
  let angleZero = null;
  let turnZero = null;
  let openedAt = 0;

  // In welche Richtung der gemessene Winkel läuft. Liegt der Magnet an der
  // Rückseite des Bretts, sieht der Sensor sein Feld spiegelbildlich und
  // zählt gegenläufig; der Griff schwenkt darum nicht anders.
  //
  // Gelesen wird die Richtung aus dem Feld und nicht angenommen: Beim
  // Neuladen stellt der Browser die zuletzt gewählte Seite dort von selbst
  // wieder her. Stünde hier fest die Vorderseite, zeigte die Seite nach einem
  // Neuladen "back" und rechnete "front" - der Ausschlag liefe verkehrt, und
  // die Null im Schlaf wanderte in die falsche Richtung.
  let angleDirection = orientationSelect.value === "back" ? -1 : 1;

  // Ob der Sensor beim letzten Bild schlief. Der Übergang ist der Augenblick,
  // in dem die Stromkarten geleert werden.
  let wasAsleep = false;

  // ─── Bytestrom ────────────────────────────────────────

  const packet = new Uint8Array(PACKET_LENGTH);
  let packetIndex = 0;   // gesammelte Bytes eines Pakets, ab 2 nach dem Sync
  let sawSync0 = false;  // letztes Byte war 0xA5, 0x5A steht aus
  let asciiBuffer = "";

  // ─── Start ────────────────────────────────────────────

  buildDialTicks();
  applyDemo();
  drawCharts();
  loadModel();

  demoSwitch.addEventListener("click", () => {
    chooseDemo(demoId === "wheel" ? "handle" : "wheel");
  });
  for (const pick of demoPicks) {
    pick.addEventListener("click", () => chooseDemo(pick.dataset.demoPick));
  }
  connectButton.addEventListener("click", connect);
  disconnectButton.addEventListener("click", () => disconnect("Connection released"));
  setSleepButton.addEventListener("click", sendSleepTimeout);
  resetZeroButton.addEventListener("click", resetZero);
  sleepInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendSleepTimeout();
  });
  clearButton.addEventListener("click", clearData);
  pauseButton.addEventListener("click", togglePause);
  orientationSelect.addEventListener("change", () => {
    angleDirection = orientationSelect.value === "back" ? -1 : 1;
    rebuildTravel();
    updateHandle(lastAngle);
  });
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
      if (!cancelled) setAck(`Connect failed: ${error.message}`, "is-error");
      return;
    }

    writer = port.writable ? port.writable.getWriter() : null;
    keepReading = true;
    overrunCount = 0;

    // Jede Verbindung beginnt ohne Nullpunkt: Der erste Winkel setzt ihn.
    angleZero = null;
    turnZero = null;
    openedAt = performance.now();

    connectButton.hidden = true;
    disconnectButton.hidden = false;
    setSleepButton.disabled = false;
    sleepInput.disabled = false;
    resetZeroButton.disabled = false;

    setConnectionState("online", `Connected · ${BAUD_RATE} baud`);
    setLiveState(true, "Reading serial stream");
    setAck("", "");

    readLoop();
    querySleepTimeout();
    showModel();
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

    // Der Nullpunkt bleibt stehen, bis die nächste Verbindung ihn neu setzt:
    // An ihm hängt der aufgezeichnete Verlauf, und der soll auch nach dem
    // Trennen noch in die andere Demo umgerechnet werden können.

    // Was das Gerät über seinen Aufbau gesagt hat, galt für diese Verbindung.
    // Die Demo bleibt stehen, nur der Schalter gibt wieder frei.
    demoFromDevice = false;
    updateDemoSwitch();
    showModel();

    connectButton.hidden = false;
    disconnectButton.hidden = true;
    setSleepButton.disabled = true;
    sleepInput.disabled = true;
    resetZeroButton.disabled = true;

    setConnectionState("offline", "Not connected");
    setLiveState(false, reason);
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
          // Der Kopf sagt, dass es passiert und wie oft; was genau, steht in
          // der Entwicklerkonsole - auf der Seite wäre es eine Meldung, mit
          // der niemand etwas anfangen kann.
          console.warn("serial stream recovered", error);
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

    // Der künftige Handschlag: Das Gerät sagt, in welchem Aufbau es steckt,
    // etwa "demo wheel" oder "OK demo handle".
    const demoMatch = /^(?:OK\s+)?demo\s+(\S+)/i.exec(line);
    if (demoMatch) {
      const announced = DEMO_NAMES[demoMatch[1].toLowerCase().replace(/[^a-z]/g, "")];
      if (!announced) {
        setAck(`Unknown demo "${demoMatch[1]}"`, "is-error");
        return;
      }
      demoFromDevice = true;
      setDemo(announced);
      setAck(`Board reports: ${DEMOS[announced].text.name}`, "is-ok");
      return;
    }

    if (/sensor\s+SLEEP/i.test(line)) sensorSleeping = true;
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
    const asleep = isSleeping();

    currentTimes.push(now);
    currentAverages.push(average);
    currentPeaks.push(peak);
    currentAsleep.push(asleep);
    rolling.push({ t: now, average, maximum: peak });
    rateStamps.push(now);

    prune(now);

    // Schläft der Sensor, bleiben die beiden Karten leer. Der Zähler misst
    // dann zwar weiter – seinen eigenen Ruhestrom –, aber die Frage, die diese
    // Karten beantworten, ist die nach dem Strom beim Wecken. Aufgezeichnet
    // wird alles: Im Verlauf steht auch der Ruhestrom, dort gehört er hin.
    if (!asleep) {
      metricAverage.textContent = formatMicroAmps(average);
      metricPeak.textContent = formatMicroAmps(peak);
    }
    updateRolling(now);
  }

  function pushAngle(degrees) {
    const now = performance.now();
    sensorSleeping = false;

    lastUnwrapped = lastUnwrapped === null
      ? degrees
      : lastUnwrapped + signedAngle(degrees - lastUnwrapped);

    angleTimes.push(now);
    angleValues.push(degrees);
    unwrappedValues.push(lastUnwrapped);

    // Die erste Meldung nach der Einschwingfrist legt den Nullpunkt fest. Die
    // Winkel davor bekommen ihren Bezug nachträglich.
    if (angleZero === null && now - openedAt >= ZERO_SETTLE_MS) {
      angleZero = degrees;
      turnZero = lastUnwrapped;
      rebuildTravel();
      setAck(zeroMessage(degrees), "is-ok");
    }

    // Ohne Nullpunkt gibt es noch keine Auslenkung. Die Reihe braucht
    // trotzdem einen Eintrag, sonst gerät sie gegen die Zeitachse aus dem
    // Tritt; sobald der Nullpunkt steht, holt `rebuildTravel` ihn nach.
    travelValues.push(travelAt(degrees, lastUnwrapped));

    prune(now);
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
    trim(currentTimes, [currentAverages, currentPeaks, currentAsleep], start);
    trim(angleTimes, [angleValues, unwrappedValues, travelValues], start);
  }

  function trim(times, series, start) {
    let drop = 0;
    while (drop < times.length && times[drop] < start) drop += 1;

    // Der letzte Punkt vor dem Fenster bleibt stehen. Er ist der Bezug für
    // alles, was von links her ins Bild läuft - und im Schlaf der einzige,
    // der noch sagt, wo der Griff steht. Ohne ihn liefe die Reihe leer,
    // sobald die letzte Messung hinten aus dem Fenster fällt: Der gehaltene
    // Wert verschwände mit ihr, und die Anzeige behauptete, es sei nichts
    // mehr da - dabei steht der Griff unverändert, wo er stand.
    if (drop > 0) drop -= 1;

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
      const { DemoModel } = await import(MODEL_MODULE);
      model = new DemoModel(handleCanvas);
      await model.showBase(demo.rig);
    } catch (error) {
      model = null;
      console.warn("3D model unavailable, the drawing stays.", error);
      return;
    }
    handleCanvas.hidden = false;
    handleStage.classList.add("has-model");

    // Beide Demos liegen bereit, bevor ein Gerät kommt: So fährt die richtige
    // ohne Wartezeit ein, sobald die Verbindung steht.
    for (const each of Object.values(DEMOS)) model.preload(each.rig);
    showModel();
  }

  // Ohne Gerät steht nur die leere Halterung auf der Bühne - welcher Aufbau
  // kommt, weiss die Seite erst mit der Verbindung. Dann fährt die Demo
  // hinein, beim Trennen oder Wechseln wieder hinaus.
  async function showModel() {
    if (!model) return;
    if (!port) {
      model.unmount();
      return;
    }

    try {
      if (!(await model.mount(demo.rig))) return;   // inzwischen etwas anderes verlangt
    } catch (error) {
      console.warn(`3D model of the ${demo.text.name} unavailable.`, error);
      return;
    }
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
      stageTurns.textContent = "\u2013";
      metricAngle.textContent = "--";
      if (model) model.reset();
      return;
    }

    stageAngle.textContent = `${degrees}\u00b0`;
    if (demo.kind === "turns") {
      updateWheel();
      return;
    }

    dialValue.textContent = `${degrees}\u00b0`;
    dialNeedle.style.transform = `rotate(${degrees}deg)`;
    dialArc.setAttribute("d", arcPath(degrees));
    metricAngle.textContent = `${degrees}\u00b0`;

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
    if (model) model.setAngle(angleDirection * (degrees - angleZero));
  }

  // Beim Lenkrad zählt nicht, wo im Kreis es steht, sondern wie oft es sich
  // seit der Null gedreht hat. Die Zeichnung zeigt dazu die Stellung
  // innerhalb der laufenden Umdrehung; die Zahl in ihrer Mitte sind die
  // Umdrehungen.
  function updateWheel() {
    if (angleZero === null) {
      dialValue.textContent = "\u2013";
      dialNeedle.style.transform = "rotate(0deg)";
      dialArc.setAttribute("d", "");
      stageTravel.textContent = "\u2013";
      stageTurns.textContent = "\u2013";
      metricAngle.textContent = "--";
      return;
    }

    const rotation = wheelRotation(lastUnwrapped);
    const turns = formatTurns(rotation / 360);
    const within = ((rotation % 360) + 360) % 360;

    dialValue.textContent = turns;
    dialNeedle.style.transform = `rotate(${within}deg)`;
    dialArc.setAttribute("d", arcPath(within));
    stageTravel.textContent = `${formatSigned(Math.round(rotation))}\u00b0`;
    stageTurns.textContent = turns;
    metricAngle.textContent = turns;
    if (model) model.setAngle(rotation);
  }

  // Die Drehung des Lenkrads seit der Null, in Grad und mit Vorzeichen:
  // rechtsherum positiv.
  function wheelRotation(unwrapped) {
    return angleDirection * (unwrapped - turnZero);
  }

  function formatTurns(turns) {
    return formatSigned(Math.abs(turns) < 0.005 ? 0 : turns, 2);
  }

  function formatSigned(value, decimals = 0) {
    const text = Math.abs(value).toFixed(decimals);
    if (value > 0) return `+${text}`;
    if (value < 0) return `\u2212${text}`;
    return text;
  }

  // Was die Demo aus einer Meldung macht: beim Griff die Auslenkung in Grad,
  // beim Lenkrad die Umdrehungen. Vor dem Nullpunkt gibt es weder das eine
  // noch das andere.
  function travelAt(degrees, unwrapped) {
    if (angleZero === null) return 0;
    if (demo.kind === "turns") return wheelRotation(unwrapped) / 360;
    return handleSwing(degrees);
  }

  function handleSwing(degrees) {
    return Math.min(Math.max(rawSwing(degrees), 0), travelLimit);
  }

  // Dasselbe ungekappt. Die Anzeige braucht das nicht - unter null gibt es
  // keine Auslenkung zu zeigen -, die Frage nach dem Nullpunkt beantwortet
  // aber erst das Vorzeichen: Es sagt, auf welcher Seite der Null der Hebel
  // steht.
  function rawSwing(degrees) {
    return angleDirection * signedAngle(degrees - angleZero);
  }

  // Die aufgezeichnete Auslenkung hängt am Nullpunkt. Verschiebt der sich, gilt
  // der neue rückwirkend: Der Verlauf zeigt den Griff, wie er zur jetzigen
  // Null steht, und nicht zu einer, die niemand mehr sieht. Dasselbe gilt
  // beim Wechsel der Demo: Aus denselben Meldungen werden dann Umdrehungen
  // statt Grad, oder umgekehrt.
  function rebuildTravel() {
    travelValues.length = angleValues.length;
    for (let index = 0; index < angleValues.length; index += 1) {
      travelValues[index] = travelAt(angleValues[index], unwrappedValues[index]);
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
      turnZero = null;
      updateHandle(null);
      setAck(`${demo.text.name} zero cleared, next reading sets it`, "is-ok");
      return;
    }

    angleZero = lastAngle;
    turnZero = lastUnwrapped;
    rebuildTravel();
    updateHandle(lastAngle);
    setAck(zeroMessage(lastAngle), "is-ok");
  }

  function zeroMessage(degrees) {
    return demo.kind === "turns"
      ? `Turns counted from ${degrees}°`
      : `Handle zero at ${degrees}°`;
  }

  // Schläft der Sensor, liegt der Griff in Ruhe: Wer ihn hielte, bewegte ihn,
  // und der Sensor bliebe wach. Zeigt die Auslenkung in dieser Lage ins
  // Minus, steht der Hebel hinter seiner eigenen Null - der Nullpunkt stammt
  // dann aus einer Lage, die der Griff in Ruhe gar nicht einnimmt. Weil die
  // Anzeige unter null kappt, bliebe das sonst unsichtbar: Sie zeigte null,
  // und der ganze Weg bis zur wahren Ruhelage fehlte am Ausschlag. Der
  // ruhende Winkel wird deshalb zur neuen Null.
  //
  // Das greift nur nach unten. Ein Nullpunkt, der zu weit hinten liegt, lässt
  // sich im Schlaf nicht erkennen - eine Auslenkung nach vorn ist von einem
  // falsch gesetzten Nullpunkt nicht zu unterscheiden, solange der Griff
  // ruht. Die Probe darauf hiesse, jede gehaltene Stellung zur Ruhelage zu
  // erklären.
  //
  // Für das Lenkrad gilt das alles nicht: Es hat keinen Anschlag, und jede
  // Stellung, auch links der Null, ist eine, in der es ruhen kann.
  function autoZero() {
    if (demo.kind !== "swing") return;
    if (angleZero === null || lastAngle === null) return;
    if (rawSwing(lastAngle) >= 0) return;

    angleZero = lastAngle;
    turnZero = lastUnwrapped;
    rebuildTravel();
    updateHandle(lastAngle);
    setAck(`Handle zero moved to ${lastAngle}° while asleep`, "is-ok");
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

  function frame() {
    prune(viewNow());
    updateRolling(performance.now());   // die Messwerte bleiben auch angehalten aktuell

    // Was der Sensor im Schlaf nicht misst, soll auch nicht dastehen. Beim
    // Einschlafen werden die beiden Karten geleert und bleiben leer, bis das
    // erste Paket nach dem Aufwachen sie wieder füllt.
    const asleep = isSleeping();
    if (asleep && !wasAsleep) {
      metricAverage.textContent = "--";
      metricPeak.textContent = "--";
    }
    wasAsleep = asleep;

    // Erst im Schlaf steht fest, dass der Griff wirklich losgelassen ist.
    if (asleep) autoZero();

    // `hidden` als Eigenschaft kennt nur HTML; die Zeichnung ist SVG und
    // braucht das Attribut selbst.
    sleepBadge.toggleAttribute("hidden", !asleep);
    for (const card of sleepingCards) card.classList.toggle("is-asleep", asleep);

    drawCharts();
    requestAnimationFrame(frame);
  }

  function drawCharts() {
    drawPlot(currentCanvas, currentContext, currentTimes, [
      { data: currentPeaks, color: PALETTE.peak, width: 1.4 },
      { data: currentAverages, color: PALETTE.average, width: 1.8 },
    ], { fixed: false, stems: currentAsleep });

    // Schläft der Sensor, bricht die Linie nicht ab: Der Griff steht ja
    // weiter, wo er stand. Sie läuft waagerecht weiter und wechselt dabei
    // die Farbe – gemessen ist dieser Abschnitt nicht. Bis an den rechten
    // Rand reicht er nur, solange eine Verbindung besteht; ohne sie ist
    // nichts zu halten, sondern schlicht Schluss.
    const hold = { holdColor: PALETTE.asleep, holdUntil: port ? viewNow() : null };

    // Das Lenkrad kennt keinen Rahmen wie den vollen Kreis: Die Achse folgt
    // den Umdrehungen, wie viele es auch werden, mindestens aber eine.
    if (demo.kind === "turns") {
      drawPlot(angleCanvas, angleContext, angleTimes, [
        { data: travelValues, color: PALETTE.travel, width: 1.8 },
      ], { fixed: false, nice: true, span: 1, ...hold });
      return;
    }

    drawPlot(angleCanvas, angleContext, angleTimes, [
      { data: angleValues, color: PALETTE.angle, width: 1.8 },
      { data: travelValues, color: PALETTE.travel, width: 1.8 },
    ], { fixed: true, minimum: 0, maximum: 360, ...hold });
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
    let gridStep = 0;   // 0: fünf gleiche Teile des Bereichs
    if (options.fixed) {
      minimum = options.minimum;
      maximum = options.maximum;
    } else if (options.nice) {
      // Grenzen und Raster auf runden Schritten, damit die Beschriftung
      // auch bei Bruchteilen lesbar bleibt - 0.5 statt 0.4667.
      let low = Infinity;
      let high = -Infinity;
      for (const entry of series) {
        for (const value of entry.data) {
          if (value < low) low = value;
          if (value > high) high = value;
        }
      }
      if (low > high) {
        low = 0;
        high = 0;
      }
      const span = options.span || 1;
      if (high - low < span) {
        const middle = (high + low) / 2;
        low = middle - span / 2;
        high = middle + span / 2;
      }
      gridStep = niceStep((high - low) / 5);
      minimum = Math.floor(low / gridStep) * gridStep;
      maximum = Math.ceil(high / gridStep) * gridStep;
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
    const lines = gridStep ? Math.round(range / gridStep) : 5;
    const valueDecimals = gridStep >= 1 || !gridStep
      ? 0
      : Math.min(3, Math.ceil(-Math.log10(gridStep) - 1e-9));
    for (let index = 0; index <= lines; index += 1) {
      const value = minimum + (range * index) / lines;
      const y = Math.round(yOf(value)) + 0.5;
      context.strokeStyle = PALETTE.grid;
      context.beginPath();
      context.moveTo(padLeft, y);
      context.lineTo(width - padRight, y);
      context.stroke();
      context.fillStyle = PALETTE.text;
      const label = valueDecimals
        ? (Math.abs(value) < gridStep / 2 ? 0 : value).toFixed(valueDecimals)
        : Math.round(value).toString();
      context.fillText(label, padLeft - 8, y);
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

    // Wo der Sensor schlief, steht hier je Punkt eine Notiz. Fehlt sie, ist
    // die ganze Reihe gemessene Bewegung und wird durchgezogen.
    const asleepAt = options.stems || null;
    const baseline = yOf(0);

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
        // Ein Punkt aus dem Schlaf gehört nicht in den Linienzug: Er bekommt
        // seine eigene Senkrechte, und der Stift hebt vor und nach ihm ab.
        if (asleepAt && asleepAt[index]) {
          penDown = false;
          continue;
        }
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

      if (asleepAt) drawStems(context, entry, times, asleepAt, xOf, yOf, baseline);

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

  // Schläft der Sensor, misst er nur im Takt seines eigenen Aufwachens. Zwei
  // benachbarte Punkte liegen dann weit auseinander, und eine Linie zwischen
  // ihnen zöge die kurze Spitze zu einer breiten Flanke: Sie behauptete einen
  // Anstieg und ein Abklingen, die so nie gemessen wurden. Gezeichnet wird
  // deshalb jeder Punkt für sich - als Senkrechte auf die Null. Sie sagt, wie
  // hoch der Strom war, ohne etwas über die Zeit davor und danach zu sagen.
  //
  // Je Pixelspalte steht nur eine Senkrechte, von der Null bis zum weitesten
  // Ausschlag, und Köpfe nur auf dem höchsten und dem tiefsten Wert. Alles
  // dazwischen läge ohnehin auf ihr, kostete aber je Bild einen eigenen
  // Strich und Kreis - bei einem vollen Fenster aus dem Schlaf sind das
  // Zehntausende, und die Anzeige geriete ins Stocken. Die Senkrechten sind
  // Rechtecke statt Linien: Die zeichnet die Leinwand um ein Vielfaches
  // schneller.
  function drawStems(context, entry, times, asleep, xOf, yOf, baseline) {
    const data = entry.data;
    const columns = [];   // flach: highX, highY, lowX, lowY, ...

    let column = NaN;
    let highX = 0;
    let highY = 0;
    let lowX = 0;
    let lowY = 0;
    const flush = () => {
      if (!Number.isNaN(column)) columns.push(highX, highY, lowX, lowY);
    };

    for (let index = 0; index < data.length; index += 1) {
      if (!asleep[index]) continue;
      const x = xOf(times[index]);
      const y = yOf(data[index]);
      const here = Math.floor(x);
      if (here !== column) {
        flush();
        column = here;
        highX = lowX = x;
        highY = lowY = y;
        continue;
      }
      // Bildschirmkoordinaten: oben ist das kleinere y.
      if (y < highY) {
        highX = x;
        highY = y;
      }
      if (y > lowY) {
        lowX = x;
        lowY = y;
      }
    }
    flush();
    if (!columns.length) return;

    const stemWidth = entry.width || 1.6;
    context.fillStyle = entry.color;
    for (let index = 0; index < columns.length; index += 4) {
      const top = Math.min(baseline, columns[index + 1]);
      const bottom = Math.max(baseline, columns[index + 3]);
      context.fillRect(columns[index] - stemWidth / 2, top, stemWidth, bottom - top);
    }

    // Der Kopf der Senkrechten. Er trägt den Messwert und hält ihn auch dort
    // sichtbar, wo die Spitze nur einen Punkt hoch ist.
    context.beginPath();
    for (let index = 0; index < columns.length; index += 4) {
      const highX = columns[index];
      const highY = columns[index + 1];
      const lowX = columns[index + 2];
      const lowY = columns[index + 3];
      context.moveTo(highX + STEM_DOT, highY);
      context.arc(highX, highY, STEM_DOT, 0, Math.PI * 2);
      if (lowX !== highX || lowY !== highY) {
        context.moveTo(lowX + STEM_DOT, lowY);
        context.arc(lowX, lowY, STEM_DOT, 0, Math.PI * 2);
      }
    }
    context.fill();
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

  // ─── Demo ─────────────────────────────────────────────

  function readStoredDemo() {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored && DEMOS[stored]) return stored;
    } catch { /* ohne Speicher gilt eben der Türgriff */ }
    return "handle";
  }

  // Die Wahl am Schalter. Hat das Gerät seinen Aufbau genannt, gilt der.
  function chooseDemo(id) {
    if (demoFromDevice || !DEMOS[id]) return;
    try { localStorage.setItem(DEMO_STORAGE_KEY, id); } catch { /* nur nicht gemerkt */ }
    setDemo(id);
  }

  function setDemo(id) {
    if (id === demoId) {
      updateDemoSwitch();
      return;
    }
    demoId = id;
    demo = DEMOS[id];
    applyDemo();
    showModel();
  }

  // Bringt Beschriftungen, Verlauf und Anzeige auf die laufende Demo. Die
  // Messungen bleiben dieselben; nur was aus ihnen gemacht wird, ändert sich.
  function applyDemo() {
    const { text } = demo;
    travelLimit = demo.rig.travel;

    document.body.dataset.demo = demoId;
    for (const element of demoOnly) element.hidden = element.dataset.only !== demoId;

    pageTitle.textContent = text.title;
    stageTravelLabel.textContent = text.travel;
    metricAngleLabel.textContent = text.metric;
    metricAngleUnit.textContent = text.metricUnit;
    angleChartTitle.textContent = text.chart;
    resetZeroButton.textContent = text.reset;
    resetZeroButton.title = text.resetTitle;
    handleCanvas.setAttribute("aria-label", text.model);
    dialCaption.textContent = demo.kind === "turns" ? "TURNS" : "DEGREES";
    hint.textContent = text.hint;

    updateDemoSwitch();
    rebuildTravel();
    updateHandle(lastAngle);
  }

  function updateDemoSwitch() {
    demoSwitch.setAttribute("aria-checked", String(demoId === "wheel"));
    demoSwitch.disabled = demoFromDevice;
    for (const pick of demoPicks) {
      pick.classList.toggle("is-active", pick.dataset.demoPick === demoId);
      pick.disabled = demoFromDevice;
    }
    demoSwitch.closest(".demo-switch").title = demoFromDevice
      ? "Set by the board"
      : "Temporary: chooses the demo until the board reports it itself";
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
    currentAsleep.length = 0;
    angleTimes.length = 0;
    angleValues.length = 0;
    unwrappedValues.length = 0;
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
})();
