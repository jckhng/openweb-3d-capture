import JSZip from "jszip";
import { buildDatasetFiles } from "./serialization";
import { generateDatasetSeedPointCloud } from "../pointcloud/generate";
import type { CaptureDataset } from "../shared/types";

export async function exportDatasetZip(dataset: CaptureDataset): Promise<Blob> {
  const seed = await generateDatasetSeedPointCloud(dataset);
  const pointCloud = seed ? { path: "pointcloud.ply", data: seed.data } : undefined;
  const zip = new JSZip();
  for (const file of buildDatasetFiles(dataset, pointCloud)) {
    zip.file(file.path, file.data);
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}
