import type { CSSProperties } from "react";

type Tone = "silver" | "dark" | "blue";

export type Coin3DProps = {
  front: string;
  back?: string;
  tone?: Tone;
  backTone?: Tone;
  glow?: string;
  size?: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
};

const BASE_SIZE = 236;

function faceStyle(tone: Tone, glow: string, back: boolean): CSSProperties {
  const transform = back ? "rotateY(180deg) translateZ(15px)" : "translateZ(15px)";
  const common: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    transform,
  };

  if (tone === "dark") {
    return {
      ...common,
      background: "radial-gradient(circle at 34% 28%, #232833, #0a0b0d 72%)",
      boxShadow: `inset 0 0 0 7px rgba(255,255,255,0.12), inset 0 0 22px rgba(0,0,0,0.5), 0 26px 70px ${glow}`,
    };
  }

  if (tone === "blue") {
    return {
      ...common,
      background: "radial-gradient(circle at 34% 28%, #4d86ff, #0052ff 58%, #0038b0)",
      boxShadow: `inset 0 0 0 7px rgba(255,255,255,0.28), inset 0 0 22px rgba(0,0,0,0.28), 0 26px 70px ${glow}`,
    };
  }

  return {
    ...common,
    background: "radial-gradient(circle at 34% 28%, #f6f8fb, #d2d7df 55%, #9ba2ad)",
    boxShadow: `inset 0 0 0 7px rgba(255,255,255,0.5), inset 0 0 0 9px rgba(0,0,0,0.06), inset 0 0 22px rgba(0,0,0,0.12), 0 26px 70px ${glow}`,
  };
}

const specularStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.55), transparent 44%)",
};

const edgeLayers = Array.from({ length: 13 }, (_, index) => -12 + index * 2);

/**
 * Spinning 3D coin used in the hero. The edge is faked with a stack of thin
 * layers between the two faces so the coin reads as solid while it rotates.
 */
export function Coin3D({
  front,
  back,
  tone = "silver",
  backTone,
  glow = "rgba(0,82,255,0.30)",
  size = BASE_SIZE,
  duration = 18,
  className,
  style,
}: Coin3DProps) {
  const scale = size / BASE_SIZE;
  const backFace = back ?? front;
  const backFaceTone = backTone ?? tone;

  return (
    <div className={`coin3d ${className ?? ""}`.trim()} style={style} aria-hidden="true">
      <div className="coin3d-glow" style={{ background: `radial-gradient(circle, ${glow}, transparent 60%)` }} />
      <div className="coin3d-tilt" style={{ transform: `rotateX(-14deg) scale(${scale})` }}>
        <div className="coin3d-float">
          <div className="coin3d-body" style={{ animation: `coin3dSpin ${duration}s linear infinite` }}>
            {edgeLayers.map((z) => (
              <div className="coin3d-edge" key={z} style={{ transform: `translateZ(${z}px)` }} />
            ))}
            <div style={faceStyle(tone, glow, false)}>
              <div style={specularStyle} />
              <img className="coin3d-art" src={front} alt="" onError={(event) => event.currentTarget.remove()} />
            </div>
            <div style={faceStyle(backFaceTone, glow, true)}>
              <div style={specularStyle} />
              <img className="coin3d-art coin3d-art-back" src={backFace} alt="" onError={(event) => event.currentTarget.remove()} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Coin3D;
