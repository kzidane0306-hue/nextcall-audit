import type { ReactNode } from "react";

/**
 * Shared mission-control primitives.
 *
 * Every dashboard page is built from these: a header, bordered instrument
 * panels, telemetry cells, dial gauges and the piston block. Kept deliberately
 * server-safe (no hooks) so server components and client components can both
 * use them. Colors are the console palette: amber = running, green = done,
 * red = problem, everything else is grey.
 */

export type Tone = "dim" | "green" | "amber" | "red";

const TONE_TEXT: Record<Tone, string> = {
  dim: "text-[#1a2230]",
  green: "text-[#16a34a]",
  amber: "text-[#d97706]",
  red: "text-[#dc2626]",
};

const TONE_LED: Record<Tone, string> = {
  dim: "mc-led-dim",
  green: "mc-led-green",
  amber: "mc-led-amber",
  red: "mc-led-red",
};

export function ConsoleHeader({
  eyebrow,
  title,
  meta,
  right,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[#e4e7ec] pb-3">
      <div>
        <p className="mc-label">{eyebrow}</p>
        <h1 className="mt-1 text-base font-semibold tracking-[0.08em] text-[#1a2230]">{title}</h1>
        {meta && <p className="mt-1 text-[11px] text-[#8b95a3]">{meta}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </header>
  );
}

export function ConsolePanel({
  title,
  right,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`mc-panel ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e4e7ec] px-4 py-2.5">
        <span className="mc-label">{title}</span>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function TelemetryCell({
  label,
  value,
  tone = "dim",
  led = false,
}: {
  label: string;
  value: string;
  tone?: Tone;
  led?: boolean;
}) {
  return (
    <div className="flex min-w-[130px] flex-1 items-center gap-2 px-3 py-2">
      {led && <span className={`mc-led ${TONE_LED[tone]}`} />}
      <div className="flex min-w-0 flex-col">
        <span className="mc-label">{label}</span>
        <span className={`truncate text-[11.5px] ${TONE_TEXT[tone]}`}>{value}</span>
      </div>
    </div>
  );
}

/** A dial gauge — the machinery reads its own instruments. */
export function Gauge({
  label,
  value,
  max,
  unit,
  tone = "amber",
  footer,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  tone?: "amber" | "green" | "red";
  footer?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const stroke = tone === "green" ? "#16a34a" : tone === "red" ? "#dc2626" : "#d97706";
  const needleAngle = -90 + ratio * 180;
  const arcLength = 100.5; // π × 32, the length of the dial arc

  return (
    <div className="flex flex-col gap-1.5 bg-[#ffffff] px-4 py-3">
      <span className="mc-label">{label}</span>
      <div className="flex items-center gap-3">
        <svg
          viewBox="0 0 88 56"
          className="h-14 w-[88px]"
          role="img"
          aria-label={`${label}: ${value} of ${max}`}
        >
          <path d="M 12 48 A 32 32 0 0 1 76 48" fill="none" stroke="#e4e7ec" strokeWidth="6" />
          <path
            d="M 12 48 A 32 32 0 0 1 76 48"
            fill="none"
            stroke={stroke}
            strokeWidth="6"
            className="mc-gauge-arc"
            strokeDasharray={`${(ratio * arcLength).toFixed(1)} 200`}
          />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const angle = ((-90 + tick * 180) * Math.PI) / 180;
            return (
              <line
                key={tick}
                x1={44 + Math.sin(angle) * 26}
                y1={48 - Math.cos(angle) * 26}
                x2={44 + Math.sin(angle) * 22}
                y2={48 - Math.cos(angle) * 22}
                stroke="#c6cdd6"
                strokeWidth="1"
              />
            );
          })}
          <line
            x1="44"
            y1="48"
            x2="44"
            y2="22"
            stroke="#1a2230"
            strokeWidth="1.5"
            transform={`rotate(${needleAngle} 44 48)`}
          />
          <circle cx="44" cy="48" r="2.5" fill="#1a2230" />
        </svg>
        <div className="flex flex-col">
          <span className="text-[15px] leading-none" style={{ color: stroke }}>
            {value}
          </span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#8b95a3]">
            / {max} {unit}
          </span>
        </div>
      </div>
      {footer && <span className="text-[10px] text-[#8b95a3]">{footer}</span>}
    </div>
  );
}

/** Nine pistons that fire while work is in flight. */
export function Cylinders({ busy, note }: { busy: boolean; note: string }) {
  return (
    <div className="flex flex-col justify-center gap-3 bg-[#ffffff] px-4 py-3">
      <span className="mc-label">cylinders</span>
      <div className="flex items-end gap-1.5">
        {Array.from({ length: 9 }).map((_, index) => (
          <span
            key={index}
            className={`w-1.5 bg-[#d97706] ${busy ? "mc-piston" : ""}`}
            style={{
              height: `${10 + (index % 4) * 7}px`,
              animationDelay: `${index * 0.08}s`,
              opacity: busy ? 1 : 0.22,
            }}
          />
        ))}
      </div>
      <span className="text-[10px] text-[#8b95a3]">{note}</span>
    </div>
  );
}

/** One bar of a horizontal instrument (funnel stage, provider capacity). */
export function BarRow({
  label,
  value,
  max,
  tone = "amber",
  right,
}: {
  label: string;
  value: number;
  max: number;
  tone?: Tone;
  right?: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar = tone === "green" ? "#16a34a" : tone === "red" ? "#dc2626" : tone === "amber" ? "#d97706" : "#66707d";

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em]">
        <span className="text-[#66707d]">{label}</span>
        <span className="text-[#1a2230]">{right ?? value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden bg-[#f1f3f6]">
        <div className="h-full" style={{ width: `${percent}%`, backgroundColor: bar }} />
      </div>
    </div>
  );
}
