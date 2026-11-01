import { Studio } from "@/components/studio";

export default function Home() {
  return (
    <main className="page-main mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-8">
      <header className="page-header">
        <h1 className="text-xl font-semibold md:text-2xl">Shuttle Tracker</h1>
        <p className="hidden text-sm text-zinc-500 sm:block">
          อัปโหลดวิดีโอแบดมินตัน ระบบจะจับลูก วาดเส้นวิถี และ export เป็นวิดีโอหรือข้อมูล ทุกอย่างประมวลผลในเครื่องของคุณ
        </p>
      </header>
      <Studio />
    </main>
  );
}
