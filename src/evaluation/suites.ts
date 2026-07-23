import { SKILLSBENCH_V1_1_TASK_IDS, type EvaluationSuiteDefinition } from "./evaluation-runner.js";
import { NATIVE_SKILL_CHARACTERIZATION_CASES } from "../skills/skill-lifecycle.js";

export const EVALUATION_TRIALS = [1, 2, 3] as const;
type Manifest = EvaluationSuiteDefinition & { readonly trials: typeof EVALUATION_TRIALS };

export const NATIVE_EVALUATION_MANIFEST = {
  schemaVersion: 1,
  suiteId: "native-characterization",
  kind: "native",
  version: "1",
  caseIds: NATIVE_SKILL_CHARACTERIZATION_CASES.map(({ id }) => id),
  arms: { control: "without-skill", treatment: "with-skill" },
  trials: EVALUATION_TRIALS,
} as const satisfies Manifest;

export const SKILLSBENCH_TASK_IDS = SKILLSBENCH_V1_1_TASK_IDS;

export const SKILLSBENCH_EVALUATION_MANIFEST = {
  schemaVersion: 1,
  suiteId: "skillsbench-v1.1",
  kind: "skillsbench",
  version: "1.1",
  caseIds: SKILLSBENCH_TASK_IDS,
  arms: { control: "curated", treatment: "bearing" },
  origin: "https://github.com/benchflow-ai/skillsbench",
  release: "v1.1",
  commit: "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af",
  trials: EVALUATION_TRIALS,
} as const;

export const SKILLSBENCH_SUITE: EvaluationSuiteDefinition = {
  schemaVersion: SKILLSBENCH_EVALUATION_MANIFEST.schemaVersion,
  suiteId: SKILLSBENCH_EVALUATION_MANIFEST.suiteId,
  kind: SKILLSBENCH_EVALUATION_MANIFEST.kind,
  version: SKILLSBENCH_EVALUATION_MANIFEST.version,
  caseIds: SKILLSBENCH_EVALUATION_MANIFEST.caseIds,
  arms: SKILLSBENCH_EVALUATION_MANIFEST.arms,
};

export const NATIVE_SUITE: EvaluationSuiteDefinition = {
  schemaVersion: NATIVE_EVALUATION_MANIFEST.schemaVersion,
  suiteId: NATIVE_EVALUATION_MANIFEST.suiteId,
  kind: NATIVE_EVALUATION_MANIFEST.kind,
  version: NATIVE_EVALUATION_MANIFEST.version,
  caseIds: NATIVE_EVALUATION_MANIFEST.caseIds,
  arms: NATIVE_EVALUATION_MANIFEST.arms,
};
