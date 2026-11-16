import Link from "next/link";
import EngineBackdrop from "@/components/landing/EngineBackdrop";
import { ConsolePanel } from "@/components/console/ConsoleUI";

export const metadata = {
  title: "NextCall Prospector — Outreach Machine",
  description:
    "Screenshots in, audited and emailed out. The internal console that finds local businesses, audits their websites and runs the outreach.",
};

/** The machine's real stages, in the order the worker walks them. */
const STAGES = [
  "INTAKE",
  "VISION READ",
  "DEDUPE CHECK",
  "CRAWL",
  "AUDIT ENGINE",
  "PROSPECT",
  "AI REPORT",
  "AUTO-SEND",
];

/**
 * Sheet data. Every figure is a fact about how the machine is configured right
 * now — nothing on this page is an invented statistic.
 */
const SPEC = [
  { label: "stages", value: "08" },
  { label: "mail providers", value: "03" },
  { label: "send cap / day", value: "300" },
  { label: "vision chain", value: "03" },
];

const CAPABILITIES = [
  {
    title: "01 / intake — vision, not ocr",
    body: "Paste the Google listing and Facebook About screenshots. The vision chain reads the name, rating, phone, website and email straight off the image; the old OCR parser is gone.",
  },
  {
    title: "02 / audit — reads the real site",
    body: "Follows redirects, crawls up to seven pages and pulls the title, contact form, booking, socials, emails and phones. Then it scores the site and writes the report from what it found.",
  },
  {
    title: "03 / outreach — sends, then follows up",
    body: "Emails the audit by itself, one at a time, inside three providers' free daily tiers. Follow-ups only go to the people who opened the first email — nobody gets pestered blind.",
  },
  {
    title: "04 / telemetry — it watches itself",
    body: "Opens and clicks return through the provider webhooks into their own pipeline boxes, so you can see who is reading and who is ignoring you.",
  },
];

export default function Home() {
  return (
    <div className="nc-scope relative flex min-h-screen flex-col overflow-hidden">
      {/*
        The engine sits BEHIND the hero, on the right: the text column is on the
        left so the drawing is not buried under the title, the rule, the buttons
        and the spec strip all at once. On small screens it moves behind the
        whole hero, dimmed, because there is no room for two columns.
      */}
      <div className="pointer-events-none absolute inset-x-[-30%] top-[4%] h-[46%] opacity-40 lg:inset-x-auto lg:right-[-8%] lg:top-[6%] lg:h-[74%] lg:w-[72%] lg:opacity-100">
        <EngineBackdrop />
      </div>

      {/* top rail */}
      <header className="relative z-10 flex items-center justify-between border-b border-[#e4e7ec] bg-white/70 px-5 py-3 backdrop-blur-sm">
        <span className="flex items-center gap-2">
          <span className="mc-led mc-led-green" />
          <span className="mc-label">system online</span>
        </span>
        <span className="mc-label hidden md:block">nc nextcall // outreach machine</span>
        <span className="mc-label">internal tool · unit 01</span>
      </header>

      <main className="relative z-10 flex flex-1 flex-col justify-center gap-10 px-5 py-12 lg:px-12 lg:py-16">
        {/* ---------------- hero ---------------- */}
        <section className="relative mx-auto grid w-full max-w-6xl items-center">
          {/* scrim: keeps the copy readable where it overlaps the drawing */}
          <div className="pointer-events-none absolute -inset-x-8 -inset-y-10 hidden bg-gradient-to-r from-[#f6f7f9] via-[#f6f7f9]/85 to-transparent lg:block" />

          <div className="relative flex flex-col items-start gap-5 lg:max-w-xl">
            <p className="mc-label">single operator · runs unattended</p>

            <h1 className="text-[2.4rem] font-bold leading-[1.04] tracking-[0.14em] text-[#1a2230] sm:text-5xl lg:text-[3.4rem]">
              NEXTCALL
              <br />
              <span className="nc-gradient-text">PROSPECTOR</span>
            </h1>

            <div className="flex w-full max-w-sm items-center gap-3">
              <span className="h-px flex-1 bg-gradient-to-r from-[#cdd4dd] to-transparent" />
              <span className="h-1.5 w-1.5 rotate-45 bg-indigo-600" />
              <span className="h-px w-16 bg-[#cdd4dd]" />
            </div>

            <p className="max-w-lg text-[13px] leading-relaxed text-[#66707d]">
              Screenshots in. The machine reads them, crawls the website, scores an audit, writes the
              report and emails it — then watches for the opens.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Link
                href="/dashboard"
                className="nc-gradient-primary rounded-lg px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-white shadow-md transition-all hover:brightness-110 hover:shadow-lg"
              >
                open the console
              </Link>
              <Link
                href="/dashboard/screenshot"
                className="rounded-lg border border-[#cdd4dd] bg-white px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#66707d] shadow-sm transition-all hover:border-[#4f46e5]/40 hover:text-[#1a2230] hover:shadow-md"
              >
                load screenshots
              </Link>
            </div>

            {/* sheet data */}
            <dl className="mt-4 grid w-full max-w-lg grid-cols-2 gap-px overflow-hidden rounded-xl border border-[#e4e7ec] bg-[#e4e7ec] shadow-sm sm:grid-cols-4">
              {SPEC.map((item) => (
                <div key={item.label} className="flex flex-col gap-1 bg-white px-3 py-2.5">
                  <dt className="mc-label text-[9px]">{item.label}</dt>
                  <dd className="text-[13px] font-semibold tabular-nums text-[#1a2230]">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ---------------- stage rail ---------------- */}
        <section className="mx-auto w-full max-w-6xl">
          <p className="mc-label mb-3">the run, end to end</p>
          <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[#e4e7ec] bg-[#e4e7ec] shadow-sm sm:grid-cols-4 lg:grid-cols-8">
            {STAGES.map((stage, index) => (
              <li key={stage} className="flex flex-col gap-1.5 bg-white px-3 py-3 transition-colors hover:bg-indigo-50/40">
                <span className="text-[9px] font-semibold tabular-nums text-[#d97706]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-[10px] uppercase leading-tight tracking-[0.1em] text-[#66707d]">
                  {stage}
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------------- capabilities ---------------- */}
        <div className="mx-auto grid w-full max-w-6xl gap-4 md:grid-cols-2">
          {CAPABILITIES.map((item) => (
            <ConsolePanel key={item.title} title={item.title}>
              <p className="px-4 py-4 text-[12px] leading-relaxed text-[#66707d]">{item.body}</p>
            </ConsolePanel>
          ))}
        </div>
      </main>

      <footer className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-t border-[#e4e7ec] bg-white/70 px-5 py-3 backdrop-blur-sm">
        <span className="mc-label">every stage above is real — fed by the workers</span>
        <span className="mc-label">not a public site</span>
      </footer>
    </div>
  );
}