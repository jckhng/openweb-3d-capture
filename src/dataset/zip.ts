import JSZip from "jszip";
import { buildDatasetFiles } from "./serialization";
import type { CaptureDataset } from "../shared/types";

export async function exportDatasetZip(dataset: CaptureDataset): Promise<Blob> {
  const zip = new JSZip();
  for (const file of buildDatasetFiles(dataset)) {
    zip.file(file.path, file.data);
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

