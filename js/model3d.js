// Das CAD-Modell des Türgriffs in der Live-Ansicht: Es schwenkt den Hebel um
// den Bolzen, an dem er im Gerät auch hängt.
//
// Gezeichnet wird nur, wenn sich etwas ändert. Der Zähler meldet seinen Winkel
// in Schüben und schläft dazwischen – eine Dauerschleife mit sechzig Bildern
// je Sekunde würde nichts gewinnen und den Akku belasten.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Der Knoten, den das Ausfuhrskript auf den Bolzen gesetzt hat. Seine
// X-Achse liegt auf der Schwenkachse; mehr muss die Seite nicht wissen.
const HANDLE_NODE = "handle";

// Der Weg des Hebels steht im Modell. Fehlt er, gilt dieser Wert – er ist
// derselbe, den das Ausfuhrskript einträgt.
const FALLBACK_TRAVEL = 67.31;

// Blickrichtung ohne Zutun des Betrachters: von schräg vorn auf die Seite, an
// der der Hebel schwenkt. Der Bolzen liegt quer zur Blickrichtung, damit die
// Bewegung ihre ganze Höhe zeigt und nicht in der Verkürzung verschwindet.
// Winkel als Kugelkoordinaten um den Modellmittelpunkt.
const HOME = { azimuth: 1.15, polar: 1.16 };
const POLAR_LIMITS = [0.3, 1.5];

// Luft zwischen Modell und Bildrand. Grosszügiger als beim Mausmodell: Über
// dem Griff liegt oben die Beschriftung der Bühne und unten ihre Messzeilen,
// und der ausgeschwenkte Hebel reicht bis in beide hinein.
const FIT_MARGIN = 1.18;

// So viele Blickrichtungen prüft die Abstandssuche. Feiner lohnt nicht: Die
// ungünstigste Lage ändert sich über wenige Grad kaum.
const FRAMING_AZIMUTHS = 32;
const FRAMING_POLARS = 6;

// So viele Richtungen tastet der Ladevorgang ab, um die äussersten Punkte des
// Modells zu finden. Der Hüllquader wäre einfacher, seine Ecken ragen aber
// weit über den schmalen Hebel hinaus – das Bild bliebe unnötig weit weg.
const HULL_DIRECTIONS = 32;

// An so vielen Stellen seines Weges wird der Hebel für die Bildeinpassung
// abgetastet. Mehr brauchte es nur, wenn der Bogen zwischen zwei Stellen weit
// ausbräche – dafür ist der Weg zu kurz, und den Rest trägt der Sicherheitsrand.
const SWEEP_SAMPLES = 4;

// Nach dieser Ruhezeit gleitet die Ansicht zurück in die Ausgangslage.
const RETURN_DELAY = 2200;
const RETURN_EASE = 0.055;

// Der Hebel folgt dem gemessenen Winkel nicht sprunghaft, sondern gleitet ihm
// nach. Der Zähler meldet in Schüben und lässt dazwischen Lücken; ohne dieses
// Nachlaufen ruckte der Griff im Takt der Meldungen statt zu schwenken.
const ANGLE_EASE = 0.28;
const ANGLE_SETTLED = 0.05;                              // Grad

export class HandleModel {
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
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.azimuth = HOME.azimuth;
    this.polar = HOME.polar;
    this.lastInput = 0;
    this.visible = true;
    this.frame = 0;

    this.handle = null;
    this.travel = FALLBACK_TRAVEL;
    this.angle = 0;        // gezeigter Winkel
    this.wanted = 0;       // gemessener Winkel, auf den er zugleitet

    this.hull = [];
    this.distance = 0.4;
    this.baseDistance = 0.4;

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

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.pivot.add(gltf.scene);
    this.pivot.updateMatrixWorld(true);

    this.handle = gltf.scene.getObjectByName(HANDLE_NODE);
    if (!this.handle) throw new Error(`node "${HANDLE_NODE}" missing`);

    // Der Weg des Hebels gehört zum Mechanismus und kommt deshalb aus dem
    // Modell. Eine Zahl in der Seite wäre eine zweite Stelle, an die denken
    // müsste, wer die Mechanik ändert.
    const travel = Number(gltf.scene.userData?.handleTravel);
    if (Number.isFinite(travel) && travel > 0) this.travel = travel;

    this.#measure(gltf.scene);
    this.#invalidate();
    return this;
  }

  // Äussere Punkte und Mittelpunkt des Modells. Gemessen wird nicht die
  // Ruhelage, sondern der ganze Weg des Hebels: Sonst passte das Bild genau
  // so lange, bis jemand den Griff zieht – und der Hebel schöbe sich beim
  // Ziehen über den Bildrand hinaus.
  #measure(root) {
    const points = [];
    const position = new THREE.Vector3();
    const box = new THREE.Box3();

    for (let step = 0; step < SWEEP_SAMPLES; step += 1) {
      if (this.handle) {
        this.handle.rotation.x = THREE.MathUtils.degToRad(
          (this.travel * step) / (SWEEP_SAMPLES - 1));
      }
      root.updateMatrixWorld(true);

      root.traverse((object) => {
        if (!object.isMesh) return;
        const attribute = object.geometry.getAttribute("position");
        for (let index = 0; index < attribute.count; index += 1) {
          position.fromBufferAttribute(attribute, index)
            .applyMatrix4(object.matrixWorld);
          box.expandByPoint(position);
          points.push(position.clone());
        }
      });
    }

    if (this.handle) {
      this.handle.rotation.x = THREE.MathUtils.degToRad(this.angle);
      root.updateMatrixWorld(true);
    }

    box.getCenter(this.target);
    for (const point of points) point.sub(this.target);

    // Der Hüllquader eines Hebels ist zum grossen Teil Luft. Gesucht sind
    // deshalb die äussersten Punkte in vielen Richtungen, nicht die Ecken
    // eines Quaders, den nichts ausfüllt.
    const direction = new THREE.Vector3();
    this.hull = [];
    for (let index = 0; index < HULL_DIRECTIONS; index += 1) {
      // Punkte, gleichmässig über die Kugel verteilt: Die Höhe wandert linear,
      // der Umlauf im goldenen Winkel. So ballen sie sich nicht an den Polen.
      const height = 1 - (2 * index + 1) / HULL_DIRECTIONS;
      const radius = Math.sqrt(Math.max(0, 1 - height * height));
      const turn = index * Math.PI * (3 - Math.sqrt(5));
      direction.set(Math.cos(turn) * radius, height, Math.sin(turn) * radius);

      let best = null;
      let reach = -Infinity;
      for (const point of points) {
        const along = point.dot(direction);
        if (along > reach) {
          reach = along;
          best = point;
        }
      }
      if (best) this.hull.push(best.clone());
    }

    this.#updateFraming();
  }

  // ─── Bewegung ───────────────────────────────────────

  // Der Griff kann nur, was er kann: aus der Ruhelage heraus bis an seinen
  // Anschlag. Der Zähler meldet den Winkel im vollen Kreis, deshalb wird er
  // zuerst auf die kürzeste Auslenkung zurückgeführt – 355 Grad sind fünf
  // Grad in die andere Richtung und damit die Ruhelage, nicht der Anschlag.
  setAngle(degrees) {
    if (!Number.isFinite(degrees)) return;
    const signed = ((degrees % 360) + 540) % 360 - 180;
    this.wanted = clamp(signed, 0, this.travel);
    this.#invalidate();
  }

  reset() {
    this.wanted = 0;
    this.#invalidate();
  }

  // Wie weit der Hebel gerade steht, als Anteil seines Weges. Die Seite zeigt
  // damit an, wann der Anschlag erreicht ist.
  get share() {
    return this.travel > 0 ? this.angle / this.travel : 0;
  }

  get limit() {
    return this.travel;
  }

  // ─── Bild ───────────────────────────────────────────

  #resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.#updateFraming();
    this.#invalidate();
  }

  #invalidate() {
    if (this.frame || !this.visible || document.hidden) return;
    this.frame = requestAnimationFrame(() => this.#draw());
  }

  // Der Abstand gilt für jede erreichbare Blickrichtung, nicht nur für die
  // gerade gezeigte: Sonst wüchse und schrumpfte der Griff beim Drehen.
  // Gesucht ist also die ungünstigste Lage.
  #updateFraming() {
    if (!this.hull.length) return;

    const vertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5);
    const horizontal = vertical * this.camera.aspect;
    const [lowPolar, highPolar] = POLAR_LIMITS;
    let worst = 0;

    for (let a = 0; a < FRAMING_AZIMUTHS; a += 1) {
      const azimuth = (a / FRAMING_AZIMUTHS) * Math.PI * 2;
      for (let p = 0; p <= FRAMING_POLARS; p += 1) {
        const polar = lowPolar + (highPolar - lowPolar) * (p / FRAMING_POLARS);
        worst = Math.max(worst,
          this.#fitDistance(azimuth, polar, horizontal, vertical));
      }
    }
    this.baseDistance = worst * FIT_MARGIN;
    this.distance = this.baseDistance;
  }

  // Wie weit muss die Kamera weg, damit das Modell ins Bild passt? Ein Punkt
  // ist sichtbar, solange sein seitlicher Abstand kleiner bleibt als die
  // Bildbreite in seiner Tiefe – nach dem Abstand aufgelöst ergibt das je
  // Hüllpunkt eine Untergrenze, die grösste davon gilt.
  #fitDistance(azimuth, polar, horizontal, vertical) {
    this.direction.set(
      Math.sin(polar) * Math.sin(azimuth),
      Math.cos(polar),
      Math.sin(polar) * Math.cos(azimuth),
    );
    this.right.crossVectors(this.worldUp, this.direction).normalize();
    this.upward.crossVectors(this.direction, this.right);

    let distance = 0;
    for (const point of this.hull) {
      const depth = point.dot(this.direction);
      distance = Math.max(distance,
        depth + Math.abs(point.dot(this.right)) / horizontal,
        depth + Math.abs(point.dot(this.upward)) / vertical);
    }
    return distance;
  }

  #draw() {
    this.frame = 0;
    let moving = false;

    if (this.handle) {
      const step = (this.wanted - this.angle) * ANGLE_EASE;
      if (Math.abs(this.wanted - this.angle) > ANGLE_SETTLED) {
        this.angle += step;
        moving = true;
      } else {
        this.angle = this.wanted;
      }
      // Der Knoten liegt in der Achse des Bolzens: Eine Drehung um seine
      // X-Achse ist die Drehung um die Achse.
      this.handle.rotation.x = THREE.MathUtils.degToRad(this.angle);
    }

    if (performance.now() - this.lastInput > RETURN_DELAY) {
      const azimuth = shortestAngle(this.azimuth, HOME.azimuth);
      const polar = HOME.polar - this.polar;
      this.azimuth += azimuth * RETURN_EASE;
      this.polar += polar * RETURN_EASE;
      const arrived = Math.abs(azimuth) <= 1e-4 && Math.abs(polar) <= 1e-4;
      moving = moving || !arrived;
      if (arrived) {
        this.azimuth = HOME.azimuth;
        this.polar = HOME.polar;
      }
    }

    this.direction.set(
      Math.sin(this.polar) * Math.sin(this.azimuth),
      Math.cos(this.polar),
      Math.sin(this.polar) * Math.cos(this.azimuth),
    );
    this.camera.position.copy(this.direction)
      .multiplyScalar(this.distance).add(this.target);
    this.camera.lookAt(this.target);

    this.renderer.render(this.scene, this.camera);
    if (moving) this.#invalidate();
  }
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
