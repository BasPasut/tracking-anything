import { Studio } from "@/components/studio";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">Shuttle Tracker</h1>
        <p className="text-sm text-zinc-500">
          อัปโหลดวิดีโอแบดมินตัน ระบบจะจับลูก วาดเส้นวิถี และ export เป็นวิดีโอหรือข้อมูล ทุกอย่างประมวลผลในเครื่องของคุณ
        </p>
      </header>
      <Studio />
    </main>
  );
}
