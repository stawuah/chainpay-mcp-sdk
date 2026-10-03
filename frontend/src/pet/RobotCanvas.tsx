import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { RobotModel, type Expression, type GearItem, type Motion } from "./RobotModel";

type Props = {
  reactionId?: number;
  expression: Expression;
  motion: Motion;
  look: { x: number; y: number };
  animate: boolean;
  gear: readonly GearItem[];
};

export default function RobotCanvas({ expression, motion, look, animate, gear, reactionId }: Props) {
  // Stop drawing while the tab is in the background.
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return (
    <Canvas
      className="cp-pet-canvas"
      dpr={[1, 1.5]}
      frameloop={!visible ? "never" : animate ? "always" : "demand"}
      // fov 35 leaves headroom for the antenna, the cap and a flip.
      camera={{ position: [0, 0.08, 4.4], fov: 35 }}
      gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
      aria-hidden="true"
    >
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 3, 4]} intensity={1.4} />
      <directionalLight position={[-3, 1, -2]} intensity={0.6} color="#9db8ff" />
      <RobotModel reactionId={reactionId} expression={expression} motion={motion} look={look} animate={animate} gear={gear} />
    </Canvas>
  );
}
