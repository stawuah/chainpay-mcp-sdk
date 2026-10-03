import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// The robot from the ChainPay social kit, rebuilt from primitives: a wide
// capsule head with a navy glass visor and two round eyes, blue ear discs, and
// a ball body. No model file, no textures, no HDR download.

export type Expression = "idle" | "happy" | "sleep" | "low" | "grumpy" | "surprised" | "dizzy" | "excited" | "off";
export type Motion = "none" | "spin" | "shake" | "eat" | "nope" | "dance" | "flip";
export type GearItem = "antenna" | "scarf" | "cap";

const BLUE = "#0052FF";
const NAVY = "#14213D";

type Props = {
  reactionId?: number;
  expression: Expression;
  motion: Motion;
  /** Pointer position relative to the robot, roughly -1..1 on each axis. */
  look: { x: number; y: number };
  animate: boolean;
  gear: readonly GearItem[];
};

function Studio() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

const lerp = THREE.MathUtils.lerp;

export function RobotModel({ expression, motion, look, animate, gear, reactionId }: Props) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Group>(null);
  const discs = useRef<THREE.Group>(null);
  const arcs = useRef<THREE.Group>(null);
  const visorMat = useRef<THREE.MeshPhysicalMaterial>(null);
  const blink = useRef({ next: 2, until: 0 });
  const motionStart = useRef(0);
  const { invalidate, clock } = useThree();

  const materials = useMemo(() => {
    const shell = new THREE.MeshPhysicalMaterial({
      color: "#f4f7ff",
      roughness: 0.28,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    const blue = new THREE.MeshPhysicalMaterial({ color: BLUE, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 });
    const eye = new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false });
    const navy = new THREE.MeshPhysicalMaterial({ color: NAVY, roughness: 0.35, clearcoat: 0.6 });
    return { shell, blue, eye, navy };
  }, []);

  useEffect(() => {
    motionStart.current = clock.elapsedTime;
    invalidate();
  }, [motion, expression, reactionId, clock, invalidate]);

  useFrame((state, delta) => {
    if (!root.current || !head.current || !eyes.current || !discs.current || !arcs.current) return;
    const t = state.clock.elapsedTime;
    const since = t - motionStart.current;
    const sleepy = expression === "sleep" || expression === "low";

    // Body bob: slow and small when low on power, still when motion is off.
    const bobSpeed = sleepy ? 0.8 : expression === "excited" ? 3.2 : 1.6;
    const bobSize = expression === "low" ? 0.025 : 0.06;
    root.current.position.y = animate ? Math.sin(t * bobSpeed) * bobSize : 0;

    // One-shot reactions, each about a second long.
    let spin = 0;
    let shake = 0;
    let hop = 0;
    let flip = 0;
    if (motion === "spin" && since < 1) spin = Math.sin(since * Math.PI) * Math.PI * 2 * since;
    if ((motion === "shake" || motion === "nope") && since < 0.7) shake = Math.sin(since * 40) * 0.12 * (1 - since / 0.7);
    if (motion === "eat" && since < 0.8) hop = Math.abs(Math.sin(since * Math.PI * 2.5)) * 0.12 * (1 - since / 0.8);
    if (motion === "dance" && since < 2.4) {
      const fade = 1 - since / 2.4;
      shake = Math.sin(since * 10) * 0.22 * fade;
      hop = Math.abs(Math.sin(since * 10)) * 0.1 * fade;
      spin = Math.sin(since * 5) * 0.5 * fade;
    }
    if (motion === "flip" && since < 0.9) {
      flip = (since / 0.9) * Math.PI * 2;
      hop = Math.sin((since / 0.9) * Math.PI) * 0.28;
    }
    // Dizzy: a slow drunken wobble on top of everything else.
    if (expression === "dizzy") shake += Math.sin(t * 6) * 0.14;
    root.current.rotation.y = spin;
    root.current.position.y += hop;
    root.current.rotation.z = shake;
    root.current.rotation.x = flip;

    // Head follows the pointer; sleeping heads droop instead.
    const targetYaw = sleepy ? 0 : look.x * 0.45;
    const targetPitch = sleepy ? 0.18 : -look.y * 0.25;
    head.current.rotation.y = lerp(head.current.rotation.y, targetYaw, Math.min(1, delta * 6));
    head.current.rotation.x = lerp(head.current.rotation.x, targetPitch, Math.min(1, delta * 6));
    head.current.rotation.z = lerp(head.current.rotation.z, expression === "grumpy" ? -0.12 : 0, Math.min(1, delta * 6));

    // Eyes: blink every few seconds, squint when sleepy, widen when surprised.
    if (t > blink.current.next) {
      blink.current.until = t + 0.12;
      blink.current.next = t + 2.5 + Math.random() * 3.5;
    }
    const blinking = animate && t < blink.current.until;
    const openness = {
      idle: 1,
      happy: 1,
      sleep: 0.12,
      low: 0.45,
      grumpy: 0.55,
      surprised: 1.3,
      dizzy: 1,
      excited: 1.25,
      off: 0.02,
    }[expression];
    const targetY = blinking && expression !== "off" ? 0.1 : openness;
    const targetX = expression === "surprised" || expression === "excited" ? 1.2 : expression === "off" ? 0.02 : 1;
    eyes.current.scale.y = lerp(eyes.current.scale.y, targetY, Math.min(1, delta * 18));
    eyes.current.scale.x = lerp(eyes.current.scale.x, targetX, Math.min(1, delta * 12));
    eyes.current.position.x = lerp(eyes.current.position.x, sleepy ? 0 : look.x * 0.06, Math.min(1, delta * 8));
    eyes.current.position.y = lerp(eyes.current.position.y, sleepy ? -0.03 : look.y * 0.04, Math.min(1, delta * 8));
    discs.current.visible = expression !== "happy";
    arcs.current.visible = expression === "happy";
    // Dizzy eyes circle around each other.
    discs.current.rotation.z = expression === "dizzy" ? t * 7 : lerp(discs.current.rotation.z % (Math.PI * 2), 0, Math.min(1, delta * 10));

    if (visorMat.current) {
      const glow = expression === "off" ? 0 : expression === "low" ? 0.02 : expression === "sleep" ? 0.04 : expression === "excited" ? 0.3 : 0.16;
      visorMat.current.emissiveIntensity = lerp(visorMat.current.emissiveIntensity, glow, Math.min(1, delta * 4));
    }

    if (!animate && since > 1.2) return;
    if (!animate) invalidate();
  });

  return (
    <group ref={root}>
      <group ref={head} position={[0, 0.34, 0]}>
        {/* Head: a capsule on its side, slightly flattened front to back. */}
        <mesh rotation={[0, 0, Math.PI / 2]} scale={[1, 1, 0.92]} material={materials.shell}>
          <capsuleGeometry args={[0.58, 0.56, 12, 32]} />
        </mesh>
        {/* Visor */}
        <mesh rotation={[0, 0, Math.PI / 2]} position={[0, -0.02, 0.43]} scale={[0.9, 0.95, 0.42]}>
          <capsuleGeometry args={[0.37, 0.5, 12, 32]} />
          <meshPhysicalMaterial
            ref={visorMat}
            color={NAVY}
            emissive={BLUE}
            emissiveIntensity={0.16}
            roughness={0.12}
            clearcoat={1}
            clearcoatRoughness={0.04}
          />
        </mesh>
        <group ref={eyes} position={[0, -0.01, 0.59]}>
          <group ref={discs}>
            <mesh position={[-0.2, 0, 0]} material={materials.eye}>
              <circleGeometry args={[0.088, 32]} />
            </mesh>
            <mesh position={[0.2, 0, 0]} material={materials.eye}>
              <circleGeometry args={[0.088, 32]} />
            </mesh>
          </group>
          {/* Happy eyes: ^^ arcs */}
          <group ref={arcs} visible={false}>
            <mesh position={[-0.2, -0.03, 0]} material={materials.eye}>
              <torusGeometry args={[0.085, 0.024, 8, 32, Math.PI]} />
            </mesh>
            <mesh position={[0.2, -0.03, 0]} material={materials.eye}>
              <torusGeometry args={[0.085, 0.024, 8, 32, Math.PI]} />
            </mesh>
          </group>
        </group>
        {gear.includes("antenna") ? (
          <group position={[0.24, 0.56, 0]} rotation={[0, 0, -0.25]}>
            <mesh position={[0, 0.1, 0]} material={materials.navy}>
              <cylinderGeometry args={[0.022, 0.026, 0.2, 12]} />
            </mesh>
            <mesh position={[0, 0.23, 0]} material={materials.blue}>
              <sphereGeometry args={[0.065, 24, 16]} />
            </mesh>
          </group>
        ) : null}
        {gear.includes("cap") ? (
          <group position={[-0.12, 0.5, 0.02]} rotation={[0.08, 0, 0.12]}>
            <mesh scale={[1, 0.5, 0.92]} material={materials.blue}>
              <sphereGeometry args={[0.4, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
            </mesh>
            <mesh position={[0, 0.005, 0.3]} rotation={[0.12, 0, 0]} scale={[1, 1, 0.75]} material={materials.navy}>
              <cylinderGeometry args={[0.3, 0.3, 0.025, 32, 1, false, -Math.PI / 2, Math.PI]} />
            </mesh>
          </group>
        ) : null}
        {/* Ear discs */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.87, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={materials.blue}>
            <cylinderGeometry args={[0.2, 0.22, 0.1, 32]} />
          </mesh>
        ))}
      </group>
      {gear.includes("scarf") ? (
        <group position={[0, -0.2, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={materials.blue}>
            <torusGeometry args={[0.36, 0.085, 16, 40]} />
          </mesh>
          <mesh position={[0.2, -0.16, 0.33]} rotation={[0.25, 0, -0.2]} material={materials.blue}>
            <boxGeometry args={[0.13, 0.26, 0.05]} />
          </mesh>
        </group>
      ) : null}
      {/* Body */}
      <mesh position={[0, -0.6, -0.05]} material={materials.shell}>
        <sphereGeometry args={[0.44, 48, 32]} />
      </mesh>
      <Studio />
    </group>
  );
}
