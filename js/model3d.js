// Die CAD-Modelle der Demos in der Live-Ansicht: der Türgriff, dessen Hebel
// um seinen Bolzen schwenkt, und das Lenkrad, das sich auf seiner Welle frei
// dreht. Beide tragen dasselbe Zählermodul und stecken in derselben
// Halterung, einer Platte mit Schwalbenschwanzführung.
//
// Solange kein Gerät verbunden ist, weiss die Seite nicht, welcher Aufbau
// kommt - auf der Bühne steht dann nur die leere Halterung. Mit der
// Verbindung fährt die Demo so in sie hinein, wie die Führung es vorsieht:
// längs der Schienen bis an den Anschlag. Beim Trennen oder Wechseln fährt
// sie wieder hinaus.
//
// Die Modelle kommen so, wie das CAD sie ausgibt: Z oben, jedes Bauteil ein
// Knoten mit seinem Namen, kein Gelenk. Diese Datei richtet beim Laden alles
// selbst ein. Welche Bauteile sich bewegen, an welchem die Achse hängt und
// welches die Halterung ist, sagt ihr der Steckbrief der Demo in app.js. Wo
// die Achse liegt, liest sie aus der Geometrie der Welle; wo die Demo sitzt,
// aus der Lage der Halterung. Wer die Mechanik ändert, exportiert neu und muss
// sonst nichts tun, solange die Bauteile ihre Namen behalten.
//
// Gezeichnet wird nur, wenn sich etwas ändert. Der Zähler meldet seinen Winkel
// in Schüben und schläft dazwischen – eine Dauerschleife mit sechzig Bildern
// je Sekunde würde nichts gewinnen und den Akku belasten.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Blickrichtung ohne Zutun des Betrachters, als Kugelkoordinaten um den
// Modellmittelpunkt. Die leere Halterung wird von der Seite ihrer Schienen
// gezeigt: So läuft das Einfahren quer durchs Bild, von der offenen Seite bis
// an den Anschlag. Jede Demo bringt ihre eigene mit; zu der schwenkt die
// Kamera erst, wenn die Demo sitzt - zwei Bewegungen zugleich wären keine.
const BASE_HOME = { azimuth: 1.25, polar: 0.88 };
const POLAR_LIMITS = [0.3, 1.5];

// Luft zwischen Modell und Bildrand. Grosszügiger als beim Mausmodell: Über
// dem Modell liegt oben die Beschriftung der Bühne und unten ihre Messzeilen,
// und was sich bewegt, reicht bis in beide hinein.
const FIT_MARGIN = 1.18;

// Die leere Halterung ist flach und klein. Eingepasst wie eine Demo füllte
// sie die Bühne, und beim Einfahren müsste die Kamera weit zurückspringen.
// Sie steht deshalb mit Abstand da - als Platz, der auf etwas wartet.
const BASE_ROOM = 1.9;

// So viele Blickrichtungen prüft die Abstandssuche. Feiner lohnt nicht: Die
// ungünstigste Lage ändert sich über wenige Grad kaum.
const FRAMING_AZIMUTHS = 32;
const FRAMING_POLARS = 6;

// So viele Richtungen tastet der Ladevorgang ab, um die äussersten Punkte des
// Modells zu finden. Der Hüllquader wäre einfacher, seine Ecken ragen aber
// weit über den schmalen Hebel hinaus – das Bild bliebe unnötig weit weg.
const HULL_DIRECTIONS = 32;

// An so vielen Stellen seines Weges wird das Bewegliche für die Bildeinpassung
// abgetastet: beim Hebel über seinen kurzen Weg, beim Lenkrad über eine ganze
// Umdrehung. Den Rest zwischen zwei Stellen trägt der Sicherheitsrand.
const SWEEP_SAMPLES = 4;
const TURN_SAMPLES = 8;

// Das Einfahren: wie lange es dauert, auf welchem Anteil des Weges die Demo
// aus dem Nichts auftaucht, und wie weit vor der Halterung sie beginnt -
// eine Plattenlänge und noch etwas Luft, damit sie ganz draussen anfängt.
const MOUNT_MS = 1700;
const UNMOUNT_MS = 900;
const FADE_SHARE = 0.4;
const SLIDE_CLEARANCE = 0.03;                            // Meter

// Nach dieser Ruhezeit gleitet die Ansicht zurück in die Ausgangslage.
const RETURN_DELAY = 2200;
const RETURN_EASE = 0.055;

// Das Bewegliche folgt dem gemessenen Winkel nicht sprunghaft, sondern gleitet
// ihm nach. Der Zähler meldet in Schüben und lässt dazwischen Lücken; ohne
// dieses Nachlaufen ruckte es im Takt der Meldungen statt zu drehen.
const ANGLE_EASE = 0.28;
const ANGLE_SETTLED = 0.05;                              // Grad

const X_AXIS = new THREE.Vector3(1, 0, 0);

export class DemoModel {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 10);
    this.stage = new THREE.Group();
    this.scene.add(this.stage);

    this.home = BASE_HOME;
    this.azimuth = BASE_HOME.azimuth;
    this.polar = BASE_HOME.polar;
    this.lastInput = 0;
    this.visible = true;
    this.frame = 0;
    this.lastFrame = 0;

    // Jede Demo wird einmal geladen und eingerichtet. Die Nummer sorgt dafür,
    // dass bei raschem Hin und Her die zuletzt verlangte Demo gewinnt und
    // nicht die zuletzt geladene.
    this.prepared = new Map();
    this.ready = new Set();
    this.ticket = 0;

    // Die Halterung, die Demo auf der Bühne und die, die dort stehen soll.
    // Weichen die beiden ab, fährt die eine hinaus und dann die andere
    // hinein. `progress` ist der Weg der Demo auf der Bühne: 0 ganz draussen,
    // 1 am Anschlag.
    this.base = null;
    this.entry = null;
    this.next = null;
    this.progress = 0;

    // Der gemessene Winkel gilt der Demo, die stehen soll. Die gerade
    // hinausfährt, behält ihren.
    this.wanted = 0;

    // Rechengrössen für die Bildschleife, einmal angelegt statt je Bild neu.
    this.direction = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.upward = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.worldUp = new THREE.Vector3(0, 1, 0);

    this.#setupStage();
    this.#setupInput();

    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(canvas);

    // Ein Zeichenfeld ausserhalb des Bildes hat keine Fläche – dann ruht auch
    // das Bild.
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.#invalidate();
    });
    this.intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", () => this.#invalidate());

    this.#resize();
  }

  // ─── Aufbau ─────────────────────────────────────────

  #setupStage() {
    const generator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
    generator.dispose();
    if ("environmentIntensity" in this.scene) {
      this.scene.environmentIntensity = 0.45;
    }

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.3, 0.5, 0.35);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xbfe6ea, 0.75);
    rim.position.set(-0.35, 0.2, -0.3);
    this.scene.add(rim);
  }

  #setupInput() {
    const pointers = new Set();
    let last = null;

    this.canvas.addEventListener("pointerdown", (event) => {
      pointers.add(event.pointerId);
      last = event;
      this.canvas.setPointerCapture(event.pointerId);
      this.lastInput = Infinity;      // solange gehalten wird, kein Rücklauf
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId) || !last) return;
      this.azimuth -= (event.clientX - last.clientX) * 0.008;
      this.polar = clamp(
        this.polar - (event.clientY - last.clientY) * 0.008, ...POLAR_LIMITS);
      last = event;
      this.#invalidate();
    });

    const release = (event) => {
      pointers.delete(event.pointerId);
      last = null;
      this.lastInput = performance.now();

      // Nach dem Loslassen zeichnet niemand mehr – ohne diesen Wecker bliebe
      // die Ansicht stehen, wo der Zeiger sie gelassen hat.
      clearTimeout(this.returnTimer);
      this.returnTimer = setTimeout(() => this.#invalidate(), RETURN_DELAY + 20);
    };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", release);
  }

  // Stellt die leere Halterung auf die Bühne. Sie steckt in jedem Modell; die
  // aus dem ersten, das geladen ist, gilt für alle.
  async showBase(rig) {
    const entry = await this.#load(rig);
    if (!this.base) this.#setBase(entry);
  }

  // Lädt eine Demo im Voraus, damit sie ohne Wartezeit einfahren kann.
  preload(rig) {
    this.#load(rig).catch(() => { /* beim Einfahren wird es erneut versucht */ });
  }

  // Lässt die Demo in die Halterung fahren. Gibt `false` zurück, wenn
  // inzwischen etwas anderes verlangt wurde.
  async mount(rig) {
    const ticket = ++this.ticket;
    const entry = await this.#load(rig);
    if (!this.base) this.#setBase(entry);
    if (ticket !== this.ticket) return false;
    this.next = entry;
    this.#invalidate();
    return true;
  }

  // Lässt die Demo hinausfahren; zurück bleibt die leere Halterung.
  unmount() {
    this.ticket += 1;
    this.next = null;
    this.#invalidate();
  }

  #load(rig) {
    let pending = this.prepared.get(rig.url);
    if (!pending) {
      pending = this.#prepare(rig).then((entry) => {
        entry.distance = this.#fit(entry.hull);
        this.ready.add(entry);
        return entry;
      });
      this.prepared.set(rig.url, pending);
      // Ein gescheiterter Versuch bleibt nicht liegen: Der nächste darf es
      // noch einmal versuchen.
      pending.catch(() => this.prepared.delete(rig.url));
    }
    return pending;
  }

  #setBase(entry) {
    const group = new THREE.Group();
    group.quaternion.copy(entry.frame);
    group.add(entry.plate);
    group.updateMatrixWorld(true);

    const { hull, target } = measure(group, null, 0);
    this.base = { group, hull, target, home: BASE_HOME, distance: 0 };
    this.base.distance = this.#fit(hull) * BASE_ROOM;
    this.stage.add(group);
    this.#invalidate();
  }

  async #prepare(rig) {
    const gltf = await new GLTFLoader().loadAsync(rig.url);
    const model = gltf.scene;

    // Die Bauteile sind die obersten Knoten; ihr Name trägt hinten die
    // Nummer der Instanz (":1"), vorn den Namen aus der Konstruktion.
    const parts = [...model.children];
    const named = (prefixes) => parts.filter((part) => {
      const name = part.name.split(":")[0];
      return prefixes.some((prefix) => name.startsWith(prefix));
    });

    const [plate] = named([rig.mount]);
    if (!plate) throw new Error(`part "${rig.mount}" missing in ${rig.url}`);
    const [axisPart] = named([rig.axis]);
    if (!axisPart) throw new Error(`part "${rig.axis}" missing in ${rig.url}`);
    const moving = named(rig.moving);
    if (!moving.length) throw new Error(`no moving part found in ${rig.url}`);
    const resting = parts.filter((part) => part !== plate && !moving.includes(part));

    // Jede Datei legt die Halterung woanders hin. Gerechnet wird deshalb in
    // ihren Koordinaten: Die Platte liegt im Ursprung, und jede Demo sitzt
    // dort, wo sie in der Platte steckt. Das CAD rechnet dabei mit Z nach
    // oben, three.js mit Y - eine Vierteldrehung um X bringt beides zusammen,
    // ohne Drehsinn oder Händigkeit zu ändern.
    plate.updateMatrix();
    model.applyMatrix4(plate.matrix.clone().invert());
    const frame = new THREE.Group();
    if (rig.up === "z") frame.rotation.x = -Math.PI / 2;
    frame.add(model);
    const root = new THREE.Group();
    root.add(frame);
    root.updateMatrixWorld(true);

    applyFinish(parts, rig.finish);

    // Die Achse ist die Längsrichtung der Welle: Ein Bolzen ist viel länger
    // als dick, und genau in diese Richtung streuen seine Punkte am weitesten.
    const { centre: origin, direction } = principalAxis(pointsOf([axisPart]));
    orientAxis(direction, origin, rig.positive,
      centroid(pointsOf(moving)), centroid(pointsOf(resting)));

    // Das Logo ist ins Bauteil graviert, also aus demselben Stoff wie der
    // Rest - hell in Hell oder dunkel in Dunkel und kaum zu sehen. Es bekommt
    // seine eigene Farbe. Wohin es schaut, steht im Steckbrief: als Richtung
    // in Plattenkoordinaten, oder "out" - die Achse entlang nach aussen.
    for (const logo of rig.logos || []) {
      const [logoPart] = named([logo.part]);
      if (!logoPart) continue;
      const facing = logo.facing === "out"
        ? direction.clone().negate()
        : new THREE.Vector3(...logo.facing).normalize().applyQuaternion(frame.quaternion);
      markLogo(logoPart, facing, logo);
    }

    // Das Gelenk sitzt auf der Achse und richtet seine X-Achse nach ihr aus.
    // Darin hängt das Bewegliche - gedreht wird es dann schlicht um X.
    const hinge = new THREE.Group();
    hinge.position.copy(origin);
    hinge.quaternion.setFromUnitVectors(X_AXIS, direction);
    const handle = new THREE.Group();
    hinge.add(handle);
    root.add(hinge);
    root.updateMatrixWorld(true);
    for (const part of moving) handle.attach(part);

    // Eingepasst wird mit der Halterung, so wie die Demo am Ende dasteht.
    const travel = rig.travel > 0 ? rig.travel : Infinity;
    const { hull, target } = measure(root, handle, travel);

    // Die Führung: In Plattenkoordinaten zeigt sie längs der Schienen zum
    // Anschlag. Hinein fährt die Demo von der offenen Seite her, aus einer
    // Plattenlänge Abstand.
    const slide = new THREE.Vector3(...(rig.slide || [0, 1, 0]))
      .normalize().applyQuaternion(frame.quaternion);
    const plateSize = new THREE.Box3().setFromObject(plate).getSize(new THREE.Vector3());
    const reach = Math.abs(plateSize.dot(slide)) + SLIDE_CLEARANCE;

    // Die Platte bleibt nicht in der Demo: Sie steht fest, während die Demo
    // in sie hineinfährt. Ihre Lage ist in Plattenkoordinaten der Ursprung.
    model.remove(plate);
    plate.position.set(0, 0, 0);
    plate.quaternion.identity();
    plate.scale.set(1, 1, 1);

    // Eigene Materialien, damit die Demo beim Ein- und Ausfahren durchsichtig
    // werden kann, ohne dass es eine andere mit ihr wird.
    const materials = ownMaterials(root);

    return {
      root, handle, travel, hull, target, slide, reach, materials, plate,
      frame: frame.quaternion.clone(),
      home: rig.home || BASE_HOME,
      angle: 0,
      opacity: 1,
      distance: 0,
    };
  }

  // ─── Bewegung ───────────────────────────────────────

  // Der Griff kann nur, was er kann: aus der Ruhelage heraus bis an seinen
  // Anschlag. Der Zähler meldet den Winkel im vollen Kreis, deshalb wird er
  // zuerst auf die kürzeste Auslenkung zurückgeführt – 355 Grad sind fünf
  // Grad in die andere Richtung und damit die Ruhelage, nicht der Anschlag.
  // Ein Lenkrad hat keinen Anschlag: Es dreht genau so weit, wie es gedreht
  // wurde, auch über viele Umdrehungen.
  setAngle(degrees) {
    if (!Number.isFinite(degrees)) return;
    const travel = this.next ? this.next.travel : Infinity;
    if (Number.isFinite(travel)) {
      const signed = ((degrees % 360) + 540) % 360 - 180;
      this.wanted = clamp(signed, 0, travel);
    } else {
      this.wanted = degrees;
    }
    this.#invalidate();
  }

  reset() {
    this.wanted = 0;
    this.#invalidate();
  }

  // ─── Bild ───────────────────────────────────────────

  #resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.base) this.base.distance = this.#fit(this.base.hull) * BASE_ROOM;
    for (const entry of this.ready) entry.distance = this.#fit(entry.hull);
    this.#invalidate();
  }

  #invalidate() {
    if (this.frame || !this.visible || document.hidden) return;
    this.frame = requestAnimationFrame(() => this.#draw());
  }

  // Der Abstand gilt für jede erreichbare Blickrichtung, nicht nur für die
  // gerade gezeigte: Sonst wüchse und schrumpfte das Modell beim Drehen.
  // Gesucht ist also die ungünstigste Lage.
  #fit(hull) {
    const vertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5);
    const horizontal = vertical * this.camera.aspect;
    const [lowPolar, highPolar] = POLAR_LIMITS;
    let worst = 0;

    for (let a = 0; a < FRAMING_AZIMUTHS; a += 1) {
      const azimuth = (a / FRAMING_AZIMUTHS) * Math.PI * 2;
      for (let p = 0; p <= FRAMING_POLARS; p += 1) {
        const polar = lowPolar + (highPolar - lowPolar) * (p / FRAMING_POLARS);
        worst = Math.max(worst,
          this.#fitDistance(hull, azimuth, polar, horizontal, vertical));
      }
    }
    return worst * FIT_MARGIN;
  }

  // Wie weit muss die Kamera weg, damit das Modell ins Bild passt? Ein Punkt
  // ist sichtbar, solange sein seitlicher Abstand kleiner bleibt als die
  // Bildbreite in seiner Tiefe – nach dem Abstand aufgelöst ergibt das je
  // Hüllpunkt eine Untergrenze, die grösste davon gilt.
  #fitDistance(hull, azimuth, polar, horizontal, vertical) {
    this.direction.set(
      Math.sin(polar) * Math.sin(azimuth),
      Math.cos(polar),
      Math.sin(polar) * Math.cos(azimuth),
    );
    this.right.crossVectors(this.worldUp, this.direction).normalize();
    this.upward.crossVectors(this.direction, this.right);

    let distance = 0;
    for (const point of hull) {
      const depth = point.dot(this.direction);
      distance = Math.max(distance,
        depth + Math.abs(point.dot(this.right)) / horizontal,
        depth + Math.abs(point.dot(this.upward)) / vertical);
    }
    return distance;
  }

  // Ein Schritt des Ein- und Ausfahrens. Gibt zurück, ob noch etwas läuft.
  #advance(elapsed) {
    if (this.entry !== this.next) {
      // Erst muss hinaus, was dasteht - dann kommt das Nächste. Die Kamera
      // kehrt dabei schon zur Seitenansicht der Halterung zurück, aus der
      // auch das Nächste beim Einfahren zu sehen ist.
      this.home = this.base.home;
      if (this.entry && this.progress > 0) {
        this.progress = Math.max(0, this.progress - elapsed / UNMOUNT_MS);
      }
      if (!this.entry || this.progress === 0) {
        if (this.entry) this.stage.remove(this.entry.root);
        this.entry = this.next;
        this.progress = 0;
        if (this.entry) {
          // Ausserhalb und unsichtbar steht sie schon so, wie gemessen wurde.
          this.entry.angle = this.wanted;
          this.stage.add(this.entry.root);
        }
      }
    } else if (this.entry && this.progress < 1) {
      this.progress = Math.min(1, this.progress + elapsed / MOUNT_MS);
      if (this.progress === 1) this.home = this.entry.home;
    } else {
      return false;
    }

    if (this.entry) {
      const { root, slide, reach } = this.entry;
      root.position.copy(slide).multiplyScalar(-reach * (1 - easeInOut(this.progress)));
      fade(this.entry, clamp(this.progress / FADE_SHARE, 0, 1));
    }
    return true;
  }

  #draw() {
    this.frame = 0;
    if (!this.base) return;

    const now = performance.now();
    const elapsed = this.lastFrame ? Math.min(now - this.lastFrame, 50) : 16;
    this.lastFrame = now;
    let moving = this.#advance(elapsed);

    const entry = this.entry;
    if (entry && entry === this.next) {
      const step = (this.wanted - entry.angle) * ANGLE_EASE;
      if (Math.abs(this.wanted - entry.angle) > ANGLE_SETTLED) {
        entry.angle += step;
        moving = true;
      } else {
        entry.angle = this.wanted;
      }
    }
    // Das Gelenk liegt in der Achse: Eine Drehung um seine X-Achse ist die
    // Drehung um die Achse.
    if (entry) entry.handle.rotation.x = THREE.MathUtils.degToRad(entry.angle);

    if (performance.now() - this.lastInput > RETURN_DELAY) {
      const azimuth = shortestAngle(this.azimuth, this.home.azimuth);
      const polar = this.home.polar - this.polar;
      this.azimuth += azimuth * RETURN_EASE;
      this.polar += polar * RETURN_EASE;
      const arrived = Math.abs(azimuth) <= 1e-4 && Math.abs(polar) <= 1e-4;
      moving = moving || !arrived;
      if (arrived) {
        this.azimuth = this.home.azimuth;
        this.polar = this.home.polar;
      }
    }

    // Die Kamera geht mit der Demo: von der leeren Halterung zurück auf das
    // Bild, in das die fertige Demo passt - im selben Takt, in dem sie
    // einfährt.
    const blend = entry ? easeInOut(this.progress) : 0;
    const distance = entry
      ? THREE.MathUtils.lerp(this.base.distance, entry.distance, blend)
      : this.base.distance;
    if (entry) this.target.lerpVectors(this.base.target, entry.target, blend);
    else this.target.copy(this.base.target);

    this.direction.set(
      Math.sin(this.polar) * Math.sin(this.azimuth),
      Math.cos(this.polar),
      Math.sin(this.polar) * Math.cos(this.azimuth),
    );
    this.camera.position.copy(this.direction)
      .multiplyScalar(distance).add(this.target);
    this.camera.lookAt(this.target);

    this.renderer.render(this.scene, this.camera);
    if (moving) this.#invalidate();
    else this.lastFrame = 0;
  }
}

// ─── Einrichtung ──────────────────────────────────────

// Alle Punkte der Bauteile in Weltkoordinaten.
function pointsOf(parts) {
  const points = [];
  for (const part of parts) {
    part.traverse((object) => {
      if (!object.isMesh) return;
      const attribute = object.geometry.getAttribute("position");
      for (let index = 0; index < attribute.count; index += 1) {
        points.push(new THREE.Vector3()
          .fromBufferAttribute(attribute, index)
          .applyMatrix4(object.matrixWorld));
      }
    });
  }
  return points;
}

function centroid(points) {
  const centre = new THREE.Vector3();
  for (const point of points) centre.add(point);
  return points.length ? centre.divideScalar(points.length) : centre;
}

// Mittelpunkt und Hauptrichtung einer Punktwolke: der Eigenvektor zum
// grössten Eigenwert ihrer Streuung, gefunden durch wiederholtes Anwenden.
function principalAxis(points) {
  const centre = centroid(points);
  const spread = [0, 0, 0, 0, 0, 0];   // xx, xy, xz, yy, yz, zz
  const offset = new THREE.Vector3();
  for (const point of points) {
    offset.subVectors(point, centre);
    spread[0] += offset.x * offset.x;
    spread[1] += offset.x * offset.y;
    spread[2] += offset.x * offset.z;
    spread[3] += offset.y * offset.y;
    spread[4] += offset.y * offset.z;
    spread[5] += offset.z * offset.z;
  }

  const [xx, xy, xz, yy, yz, zz] = spread;
  const direction = new THREE.Vector3(1, 1, 1).normalize();
  for (let round = 0; round < 64; round += 1) {
    direction.set(
      xx * direction.x + xy * direction.y + xz * direction.z,
      xy * direction.x + yy * direction.y + yz * direction.z,
      xz * direction.x + yz * direction.y + zz * direction.z,
    ).normalize();
  }
  return { centre, direction };
}

// In welche Richtung die Welle im CAD zeigt, ist eine Laune der Konstruktion.
// Welche Drehung als vorwärts gilt, ist es nicht - die Achse wird deshalb so
// gewendet, dass ein positiver Winkel genau diese Drehung bedeutet:
//
// "lift"      Der Griff wird gezogen, sein freies Ende hebt sich. Geprüft
//             wird die Geschwindigkeit, die der Schwerpunkt des Beweglichen im
//             ersten Augenblick der Drehung hätte: Sie muss nach oben zeigen.
// "clockwise" Das Lenkrad dreht, von seiner freien Seite aus gesehen, im
//             Uhrzeigersinn - für den Fahrer also nach rechts. Rechtsdrehend
//             um eine Achse, die vom Betrachter weg zeigt, ist im Uhrzeiger-
//             sinn; die Achse muss also vom Beweglichen zum Ruhenden zeigen.
function orientAxis(direction, origin, positive, movingCentre, restingCentre) {
  if (positive === "lift") {
    const arm = movingCentre.clone().sub(origin);
    arm.addScaledVector(direction, -arm.dot(direction));
    const velocity = new THREE.Vector3().crossVectors(direction, arm);
    if (velocity.y < 0) direction.negate();
  } else if (positive === "clockwise") {
    const outward = movingCentre.clone().sub(restingCentre);
    if (outward.dot(direction) > 0) direction.negate();
  }
}

// Die Farben aus dem CAD sind für die Werkstatt gedacht, nicht für eine
// Bühne. Wo der Steckbrief es verlangt, bekommt ein Bauteil Farbe und
// Oberfläche von hier. Die Materialien werden dafür kopiert: Im CAD teilen
// sich oft ganz verschiedene Teile eines - etwa "Default".
function applyFinish(parts, finish) {
  if (!finish) return;
  for (const part of parts) {
    const name = part.name.split(":")[0];
    const prefix = Object.keys(finish).find((key) => name.startsWith(key));
    if (!prefix) continue;
    const { color, metalness, roughness } = finish[prefix];

    const copies = new Map();
    part.traverse((object) => {
      if (!object.isMesh) return;
      const original = object.material;
      if (!copies.has(original)) {
        const copy = original.clone();
        if (color !== undefined) copy.color.set(color);
        if (metalness !== undefined) copy.metalness = metalness;
        if (roughness !== undefined) copy.roughness = roughness;
        copies.set(original, copy);
      }
      object.material = copies.get(original);
    });
  }
}

// Gibt jedem Netz unter `root` Materialien, die nur ihm gehören, und merkt
// sich, wie durchsichtig sie von Haus aus sind. Ein Netz mit Logo trägt zwei.
function ownMaterials(root) {
  const copies = new Map();
  const own = (original) => {
    if (!copies.has(original)) {
      const copy = original.clone();
      copy.userData.opacity = copy.opacity;
      copy.userData.transparent = copy.transparent;
      copies.set(original, copy);
    }
    return copies.get(original);
  };
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(own)
      : own(object.material);
  });
  return [...copies.values()];
}

// Sucht im Bauteil die Gravur des Logos und gibt ihr ein eigenes Material.
//
// Die Gravur ist eine Fläche, parallel zur Oberfläche, in die sie eingelassen
// ist, nur ein wenig tiefer. Unter allen Flächen, die in Blickrichtung des
// Logos zeigen, ist sie die mit den meisten Dreiecken je Fläche: Schrift
// besteht aus lauter kleinen Stücken, eine glatte Oberfläche aus wenigen
// grossen. Zur Gravur gehören dazu die Wände zwischen ihr und der Oberfläche.
function markLogo(part, facing, { color, roughness = 0.45, metalness = 0 }) {
  const LEVEL_TOLERANCE = 0.00003;                       // Meter
  const MARGIN = 0.0005;                                 // Meter

  part.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry.index || Array.isArray(mesh.material)) return;
    const geometry = mesh.geometry.clone();
    const position = geometry.getAttribute("position");
    const index = geometry.index.array;
    const count = index.length / 3;

    const world = Array.from({ length: position.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    const level = world.map((point) => point.dot(facing));

    // Höhe jedes Dreiecks, das in Blickrichtung zeigt, und seine Fläche.
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const facingTriangles = [];
    for (let t = 0; t < count; t += 1) {
      const [a, b, c] = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]];
      edge1.subVectors(world[b], world[a]);
      edge2.subVectors(world[c], world[a]);
      const normal = edge1.cross(edge2);
      const area = normal.length() / 2;
      if (!area || normal.normalize().dot(facing) < 0.995) continue;
      facingTriangles.push({ t, height: level[a], area });
    }

    // Gleich hohe Dreiecke zu Ebenen zusammenfassen.
    facingTriangles.sort((x, y) => x.height - y.height);
    const planes = [];
    for (const triangle of facingTriangles) {
      const last = planes[planes.length - 1];
      if (last && triangle.height - last.height <= LEVEL_TOLERANCE) {
        last.triangles.push(triangle.t);
        last.area += triangle.area;
      } else {
        planes.push({ height: triangle.height, triangles: [triangle.t], area: triangle.area });
      }
    }
    const candidates = planes.filter((plane) => plane.triangles.length >= 30);
    if (!candidates.length) return;
    const logo = candidates.reduce((best, plane) =>
      plane.triangles.length / plane.area > best.triangles.length / best.area ? plane : best);

    // Die Oberfläche, in die das Logo eingelassen ist: die nächste Ebene
    // darüber - oder, bei einem erhabenen Logo, darunter.
    const neighbours = planes.filter((plane) => plane !== logo && plane.area > logo.area);
    if (!neighbours.length) return;
    const surface = neighbours.reduce((best, plane) =>
      Math.abs(plane.height - logo.height) < Math.abs(best.height - logo.height) ? plane : best);
    const low = Math.min(logo.height, surface.height) - LEVEL_TOLERANCE;
    const high = Math.max(logo.height, surface.height) + LEVEL_TOLERANCE;

    const bounds = new THREE.Box3();
    for (const t of logo.triangles) {
      for (let k = 0; k < 3; k += 1) bounds.expandByPoint(world[index[t * 3 + k]]);
    }
    bounds.expandByScalar(MARGIN);

    const marked = new Uint8Array(count);
    for (const t of logo.triangles) marked[t] = 1;
    const onSurface = new Set(surface.triangles);
    for (let t = 0; t < count; t += 1) {
      if (marked[t] || onSurface.has(t)) continue;
      let inside = true;
      for (let k = 0; k < 3 && inside; k += 1) {
        const vertex = index[t * 3 + k];
        inside = level[vertex] >= low && level[vertex] <= high
          && bounds.containsPoint(world[vertex]);
      }
      if (inside) marked[t] = 1;
    }

    // Erst der Körper, dann das Logo - je eine Gruppe, je ein Material.
    const reordered = new index.constructor(index.length);
    let cursor = 0;
    for (const pass of [0, 1]) {
      for (let t = 0; t < count; t += 1) {
        if (marked[t] !== pass) continue;
        reordered.set(index.subarray(t * 3, t * 3 + 3), cursor);
        cursor += 3;
      }
    }
    const logoCount = marked.reduce((sum, flag) => sum + flag, 0);
    geometry.setIndex(new THREE.BufferAttribute(reordered, 1));
    geometry.clearGroups();
    geometry.addGroup(0, (count - logoCount) * 3, 0);
    geometry.addGroup((count - logoCount) * 3, logoCount * 3, 1);

    const ink = mesh.material.clone();
    ink.color.set(color);
    ink.roughness = roughness;
    ink.metalness = metalness;
    mesh.geometry = geometry;
    mesh.material = [mesh.material, ink];
  });
}

// Blendet eine Demo ein oder aus. Ganz deckend wird sie wieder undurchsichtig
// gezeichnet: Durchsichtiges sortiert three.js nach Teilen statt nach
// Bildpunkten, und das sähe man am fertigen Modell.
function fade(entry, opacity) {
  if (entry.opacity === opacity) return;
  entry.opacity = opacity;
  entry.root.visible = opacity > 0;
  const seeThrough = opacity < 1;
  for (const material of entry.materials) {
    const transparent = seeThrough || material.userData.transparent;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    material.opacity = material.userData.opacity * opacity;
  }
}

// Äussere Punkte und Mittelpunkt des Modells. Gemessen wird nicht die
// Ruhelage, sondern der ganze Weg des Beweglichen: Sonst passte das Bild genau
// so lange, bis jemand den Griff zieht – und der Hebel schöbe sich beim
// Ziehen über den Bildrand hinaus.
//
// Der Hüllquader eines Hebels ist zum grossen Teil Luft. Gesucht sind
// deshalb die äussersten Punkte in vielen Richtungen, nicht die Ecken eines
// Quaders, den nichts ausfüllt. Welcher Punkt in einer Richtung am weitesten
// reicht, hängt nicht davon ab, von wo aus gemessen wird - der Mittelpunkt
// darf also erst am Schluss feststehen.
function measure(root, handle, travel) {
  const directions = [];
  for (let index = 0; index < HULL_DIRECTIONS; index += 1) {
    // Punkte, gleichmässig über die Kugel verteilt: Die Höhe wandert linear,
    // der Umlauf im goldenen Winkel. So ballen sie sich nicht an den Polen.
    const height = 1 - (2 * index + 1) / HULL_DIRECTIONS;
    const radius = Math.sqrt(Math.max(0, 1 - height * height));
    const turn = index * Math.PI * (3 - Math.sqrt(5));
    directions.push(new THREE.Vector3(
      Math.cos(turn) * radius, height, Math.sin(turn) * radius));
  }
  const reach = directions.map(() => -Infinity);
  const best = directions.map(() => new THREE.Vector3());
  const box = new THREE.Box3();
  const point = new THREE.Vector3();

  const visit = (mesh) => {
    const attribute = mesh.geometry.getAttribute("position");
    for (let index = 0; index < attribute.count; index += 1) {
      point.fromBufferAttribute(attribute, index).applyMatrix4(mesh.matrixWorld);
      box.expandByPoint(point);
      for (let d = 0; d < directions.length; d += 1) {
        const along = point.dot(directions[d]);
        if (along > reach[d]) {
          reach[d] = along;
          best[d].copy(point);
        }
      }
    }
  };

  const resting = [];
  const moving = [];
  root.traverse((object) => {
    if (!object.isMesh) return;
    let carried = false;
    for (let parent = object.parent; parent; parent = parent.parent) {
      if (handle && parent === handle) carried = true;
    }
    (carried ? moving : resting).push(object);
  });

  root.updateMatrixWorld(true);
  for (const mesh of resting) visit(mesh);

  if (handle) {
    const samples = Number.isFinite(travel)
      ? Array.from({ length: SWEEP_SAMPLES },
        (_, step) => (travel * step) / (SWEEP_SAMPLES - 1))
      : Array.from({ length: TURN_SAMPLES }, (_, step) => (360 * step) / TURN_SAMPLES);
    for (const degrees of samples) {
      handle.rotation.x = THREE.MathUtils.degToRad(degrees);
      root.updateMatrixWorld(true);
      for (const mesh of moving) visit(mesh);
    }
    handle.rotation.x = 0;
    root.updateMatrixWorld(true);
  }

  const target = box.getCenter(new THREE.Vector3());
  return { hull: best.map((entry) => entry.sub(target)), target };
}

// Langsam los, zügig über die Strecke, sanft an den Anschlag.
function easeInOut(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// Der kürzere der beiden Wege zwischen zwei Winkeln – sonst liefe die Ansicht
// bei der Rückkehr einmal aussen herum.
function shortestAngle(from, to) {
  return ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2)
    % (Math.PI * 2) - Math.PI;
}
