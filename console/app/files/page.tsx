import { UploadFile } from "./upload";
import { FilesTable } from "./table";
import { wsGet } from "../lib/api";

export const dynamic = "force-dynamic";
const LIMIT = 100;

export default async function FilesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  const offset = (Math.max(1, Number(page ?? 1)) - 1) * LIMIT;
  const data = await wsGet<{ files: any[]; total: number; limit: number; offset: number }>(
    `/v1/files?limit=${LIMIT}&offset=${offset}`);
  return (
    <>
      <div className="pagehead"><h1>Files</h1><UploadFile /></div>
      <p className="sub">
        Input files are uploaded here and attached to sessions; output files are produced by sessions
        (written to <code>/mnt/session/outputs</code>). A file can be attached to multiple sessions.
      </p>
      <FilesTable files={data.files} total={data.total} limit={data.limit} offset={data.offset} />
    </>
  );
}
