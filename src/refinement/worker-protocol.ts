import type { Intrinsics, Matrix4, VisualTrackingReport } from "../shared/types";

export interface VisualTrackingFrameInput {
  id: number;
  image: Blob;
  width: number;
  height: number;
  intrinsics: Intrinsics;
  cameraToWorld: Matrix4;
}

export type VisualWorkerRequest =
  | { type: "reset" }
  | { type: "track"; frame: VisualTrackingFrameInput }
  | { type: "finish"; requestId: number };

export type VisualWorkerResponse =
  | { type: "update"; report: VisualTrackingReport }
  | { type: "finished"; requestId: number; report: VisualTrackingReport }
  | { type: "error"; message: string };
