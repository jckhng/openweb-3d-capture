import JSZip from "jszip";
import { buildExportFiles, type ExportProfile } from "./serialization";
import { generateDatasetSeedPointCloud } from "../pointcloud/generate";
import type { CaptureDataset } from "../shared/types";

export type { ExportProfile } from "./serialization";

export async function exportDatasetZip(
  dataset: CaptureDataset,
  profile: ExportProfile = "canonical",
): Promise<Blob> {
  const seed = profile === "canonical" ? await generateDatasetSeedPointCloud(dataset) : undefined;
  const pointCloud = seed ? { path: "pointcloud.ply", data: seed.data } : undefined;
  const zip = new JSZip();
  for (const file of buildExportFiles(dataset, profile, pointCloud)) {
    zip.file(file.path, file.data);
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}
