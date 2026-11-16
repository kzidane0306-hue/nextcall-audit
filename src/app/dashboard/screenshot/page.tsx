import ScreenshotClient from "@/components/screenshot/ScreenshotClient";

export default function ScreenshotPage() {
    return (
        <div className="flex flex-1 flex-col p-3 sm:p-5">
            <div className="flex flex-col gap-4 p-3 sm:p-4">
                <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[#e4e7ec] pb-3">
                    <div>
                        <p className="mc-label">NextCall outreach console // unit 01</p>
                        <h1 className="mt-1 text-base font-semibold tracking-[0.08em] text-[#1a2230]">
                            CREATE FROM SCREENSHOT
                        </h1>
                    </div>
                    <p className="mc-label">every stage runs unattended — this console only watches</p>
                </header>
                <ScreenshotClient />
            </div>
        </div>
    );
}
