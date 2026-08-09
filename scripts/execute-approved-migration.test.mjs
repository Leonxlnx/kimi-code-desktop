import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  apiGetFollowingRedirects,
  apiListPaginated,
  assertFetchAllowed,
  assertPushSafety,
  buildPlan,
  buildSourcePush,
  buildUserSitePush,
  classifyState,
  createFileJournalAdapter,
  createMigrationExecutor,
  expectedApprovalBytes,
  inspectLegacyFeedApp,
  loadLegacyFeedAppAuthentication,
  normalizePages,
  pushCommand,
  validateManifest,
} from "./execute-approved-migration.mjs";

const FILE_BYTES = new Map([
  ["Kimi-Code-Desktop-0.8.3-x64-setup.exe", Buffer.from("installer\n")],
  ["Kimi-Code-Desktop-0.8.3-x64-setup.exe.sig", Buffer.from("signature\n")],
  ["latest.json", Buffer.from("{\"version\":\"0.8.3\"}\n")],
  ["SHA256SUMS.txt", Buffer.from("fixture checksum\n")],
]);
const ROOT_MANIFEST = syntheticRootManifest();

function syntheticRootManifest() {
  const sourceMainOld = "1".repeat(40);
  const sourceMainNew = "2".repeat(40);
  const sourceMainTree = "3".repeat(40);
  const sourcePagesOld = "4".repeat(40);
  const sourcePagesNew = "5".repeat(40);
  const sourcePagesTree = "6".repeat(40);
  const oldTagObject = "7".repeat(40);
  const oldTagCommit = "8".repeat(40);
  const oldTagTree = "9".repeat(40);
  const newTagObject = "a".repeat(40);
  const newTagCommit = "b".repeat(40);
  const newTagTree = "c".repeat(40);
  const branchOld = "d".repeat(40);
  const secondBranchOld = "0d".repeat(20);
  const userSiteOld = "e".repeat(40);
  const userSiteNew = "f".repeat(40);
  const userSiteTree = "0".repeat(40);
  const releaseAssets = [...FILE_BYTES].map(([name, bytes], index) => ({
    id: 9000 + index,
    name,
    bytes: bytes.length,
    sha256: sha256(bytes),
  }));

  return {
    schemaVersion: 1,
    generatedAt: "2026-08-08T18:00:00.000Z",
    approvalRequired: true,
    approvalFormat: "APPROVE CLEAN-ROOT MIGRATION MANIFEST <sha256-of-this-file>",
    approvalEligible: true,
    lastRemoteFreezeAt: "2026-08-08T18:00:00.000Z",
    lastRemoteFreezeMatched: true,
    sourceRepository: {
      repositoryId: 1303365335,
      nodeId: "R_fixture_source",
      currentName: "Leonxlnx/tasty-desktop",
      approvedName: "Leonxlnx/kimi-code-desktop",
      main: {
        expectedOld: sourceMainOld,
        approvedNew: sourceMainNew,
        approvedTree: sourceMainTree,
        action: "replace-with-exact-force-with-lease",
      },
      ghPages: {
        expectedOld: sourcePagesOld,
        approvedNew: sourcePagesNew,
        approvedTree: sourcePagesTree,
        action: "fast-forward-only",
      },
      "v0.8.3": {
        expectedOldTagObject: oldTagObject,
        expectedOldCommit: oldTagCommit,
        expectedOldTree: oldTagTree,
        approvedNewTagObject: newTagObject,
        approvedNewCommit: newTagCommit,
        approvedNewTree: newTagTree,
        action: "retarget-with-exact-tag-lease-preserve-release",
      },
      branches: [
        { name: "fixture-update", expectedOld: branchOld, action: "lease-delete" },
        { name: "fixture-update-two", expectedOld: secondBranchOld, action: "lease-delete" },
      ],
      pullRequestsToClose: [
        {
          number: 17,
          nodeId: "PR_fixture_17",
          state: "open",
          baseRef: "main",
          baseSha: sourceMainOld,
          headRef: "fixture-update",
          headSha: branchOld,
        },
        {
          number: 18,
          nodeId: "PR_fixture_18",
          state: "open",
          baseRef: "main",
          baseSha: sourceMainOld,
          headRef: "fixture-update-two",
          headSha: secondBranchOld,
        },
      ],
      desiredMetadata: {
        description: "Kimi Code Desktop fixture repository.",
        homepage: "https://github.com/Leonxlnx/kimi-code-desktop#readme",
        topics: ["desktop-app", "kimi", "test-fixture"],
      },
      desiredPages: {
        buildType: "workflow",
        cname: null,
        httpsEnforced: true,
        url: "https://leonxlnx.github.io/kimi-code-desktop/",
      },
    },
    userSiteRepository: {
      repositoryId: 1123421023,
      nodeId: "R_fixture_user_site",
      name: "Leonxlnx/Leonxlnx.github.io",
      main: {
        expectedOld: userSiteOld,
        approvedNew: userSiteNew,
        approvedTree: userSiteTree,
        action: "replace-with-exact-force-with-lease",
      },
      cname: { decision: "omit" },
      desiredPages: {
        buildType: "legacy",
        source: { branch: "main", path: "/" },
        cname: null,
        httpsEnforced: true,
        url: "https://leonxlnx.github.io/",
      },
    },
    release: {
      id: 9000,
      tag: "v0.8.3",
      preserveRecordAndAssets: true,
      signatureVerified: true,
      signatureEvidenceSha256: "a".repeat(64),
      assets: releaseAssets,
    },
    localEvidence: {
      repositories: {
        sourceRoot: {
          path: "fixtures/source-root",
          branch: "main",
          commit: sourceMainNew,
          tree: sourceMainTree,
          parent: null,
        },
        canonicalGhPages: {
          path: "fixtures/canonical-pages",
          branch: "gh-pages",
          commit: sourcePagesNew,
          tree: sourcePagesTree,
          parent: sourcePagesOld,
        },
        userSite: {
          path: "fixtures/user-site",
          branch: "main",
          commit: userSiteNew,
          tree: userSiteTree,
          parent: null,
        },
        "sanitizedV0.8.3": {
          path: "fixtures/sanitized-v0.8.3",
          branch: "main",
          commit: newTagCommit,
          tree: newTagTree,
          parent: null,
          tag: "v0.8.3",
          tagObject: newTagObject,
        },
      },
    },
    privateBackups: [],
    prerequisites: {
      ready: true,
      releaseFreeze: { required: true, activeReleaseWorkflowRunsAtCapture: [] },
      requiredEnvironments: ["github-pages", "release-signing", "legacy-update-feed"],
      requiredVariables: {
        UPDATER_FEED_MODE: "dual",
        LEGACY_FEED_REPOSITORY: "Leonxlnx/Leonxlnx.github.io",
        LEGACY_FEED_APP_ID: "424242",
      },
      requiredEnvironmentSecrets: {
        "release-signing": ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"],
        "legacy-update-feed": ["LEGACY_FEED_APP_PRIVATE_KEY"],
      },
      requiredLegacyFeedApp: {
        installedOnlyOn: "Leonxlnx/Leonxlnx.github.io",
        permissions: { metadata: "read", contents: "write" },
      },
      missingAtCapture: [],
    },
    execution: {
      stateMachineVersion: 1,
      journalPath: "journal/CUTOVER_JOURNAL.jsonl",
      steps: [
        { id: "preflight" },
        { id: "user-site-main" },
        { id: "source-refs" },
        { id: "rename" },
        { id: "close-pull-requests" },
        { id: "metadata-and-pages" },
        { id: "verify" },
      ],
    },
    postconditions: {
      canonicalEndpoint: "https://leonxlnx.github.io/kimi-code-desktop/",
      legacyEndpoint: "https://leonxlnx.github.io/tasty-desktop/",
      feedFiles: releaseAssets.map(({ id: _id, ...entry }) => entry),
      releaseRecordAndAssetsUnchanged: true,
      "signedV0.12PublicationIsSeparate": true,
      desktopInstallationIsSeparate: true,
    },
    deferredGates: {
      repositoryProtections: {
        phase: "post-cutover-pre-release",
        sourceRepositoryId: 1303365335,
        branch: "main",
        executorMustNotConfigureOrClaimCompletion: true,
        separatePolicyAndVerificationRequired: true,
        "blocksSignedV0.12Publication": true,
        blocksDesktopInstallation: true,
      },
    },
    capturedInitialState: {
      sourceRepository: {
        metadata: {
          description: "Legacy fixture repository before migration.",
          homepage: "https://leonxlnx.github.io/tasty-desktop/",
          topics: ["legacy", "test-fixture"],
        },
        pages: {
          buildType: "legacy",
          source: { branch: "gh-pages", path: "/" },
          cname: null,
          httpsEnforced: true,
          url: "https://leonxlnx.github.io/tasty-desktop/",
        },
      },
      userSiteRepository: {
        pages: {
          buildType: "legacy",
          source: { branch: "main", path: "/" },
          cname: null,
          httpsEnforced: true,
          url: "https://leonxlnx.github.io/",
        },
      },
    },
  };
}

function fixtureManifest(overrides = {}) {
  const manifest = structuredClone(ROOT_MANIFEST);
  manifest.generatedAt = "2026-08-08T18:00:00.000Z";
  manifest.lastRemoteFreezeAt = "2026-08-08T18:00:00.000Z";
  manifest.approvalEligible = true;
  manifest.prerequisites.ready = true;
  manifest.prerequisites.missingAtCapture = [];
  manifest.prerequisites.requiredVariables.LEGACY_FEED_APP_ID = "424242";
  manifest.userSiteRepository.desiredPages.url = "https://leonxlnx.github.io/";
  manifest.capturedInitialState = {
    sourceRepository: {
      metadata: {
        description: "Open-source Windows desktop harness for Kimi, OpenAI Codex, Anthropic Claude, and Cursor, built with Tauri and React.",
        homepage: "https://leonxlnx.github.io/tasty-desktop/",
        topics: [
          "agent-harness", "ai-coding", "claude-code", "codex", "coding-agent", "cursor", "desktop-app", "kimi",
          "kimi-code", "mcp", "multi-provider", "open-source", "react", "rust", "tauri", "typescript", "windows",
        ],
      },
      pages: {
        buildType: "legacy",
        source: { branch: "gh-pages", path: "/" },
        cname: null,
        httpsEnforced: true,
        url: "https://leonxlnx.github.io/tasty-desktop/",
      },
    },
    userSiteRepository: {
      pages: {
        buildType: "legacy",
        source: { branch: "main", path: "/" },
        cname: null,
        httpsEnforced: true,
        url: "https://leonxlnx.github.io/",
      },
    },
  };
  manifest.release.assets = [...FILE_BYTES].map(([name, bytes], index) => ({
    id: 9000 + index,
    name,
    bytes: bytes.length,
    sha256: sha256(bytes),
  }));
  manifest.postconditions.feedFiles = structuredClone(manifest.release.assets).map(({ id: _id, ...entry }) => entry);
  manifest.execution.journalPath = "journal/CUTOVER_JOURNAL.jsonl";
  Object.assign(manifest, overrides);
  return manifest;
}

function manifestInput(manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const hash = sha256(bytes);
  return { manifestBytes: bytes, expectedManifestSha256: hash, approvalBytes: expectedApprovalBytes(hash) };
}

function oldSnapshot(manifest) {
  const source = manifest.sourceRepository;
  const refs = {
    "refs/heads/main": source.main.expectedOld,
    "refs/heads/gh-pages": source.ghPages.expectedOld,
    "refs/tags/v0.8.3": source["v0.8.3"].expectedOldTagObject,
  };
  for (const branch of source.branches) refs[`refs/heads/${branch.name}`] = branch.expectedOld;
  return {
    sourceRepository: {
      repositoryId: source.repositoryId,
      nodeId: source.nodeId,
      name: source.currentName,
      refs,
      ordinaryHeads: Object.entries(refs).filter(([ref]) => ref.startsWith("refs/heads/")).map(([ref, object]) => ({ ref, object })),
      ordinaryTags: Object.entries(refs).filter(([ref]) => ref.startsWith("refs/tags/")).map(([ref, object]) => ({ ref, object })),
      pullRequests: source.pullRequestsToClose.map((pull) => structuredClone(pull)),
      openPullRequests: source.pullRequestsToClose.map((pull) => structuredClone(pull)),
      release: { id: manifest.release.id, tag: manifest.release.tag, assets: structuredClone(manifest.release.assets) },
      metadata: structuredClone(manifest.capturedInitialState.sourceRepository.metadata),
      pages: structuredClone(manifest.capturedInitialState.sourceRepository.pages),
    },
    userSiteRepository: {
      repositoryId: manifest.userSiteRepository.repositoryId,
      nodeId: manifest.userSiteRepository.nodeId,
      name: manifest.userSiteRepository.name,
      refs: { "refs/heads/main": manifest.userSiteRepository.main.expectedOld },
      pages: structuredClone(manifest.capturedInitialState.userSiteRepository.pages),
    },
    oldSlugRepositoryId: null,
    prerequisites: { ready: true, activeWorkflowRuns: [] },
    pages: null,
  };
}

function fakeHarness(manifest, options = {}) {
  const state = options.state ?? oldSnapshot(manifest);
  const commands = [];
  const fetches = [];
  const sleeps = [];
  const imported = new Map();
  let successfulPageReads = 0;
  let pageFailures = options.pageFailures ?? 0;
  let redirectRemaining = options.redirectOnce ? 1 : 0;

  const command = {
    async run(spec) {
      commands.push(structuredClone(spec));
      if (spec.capability === "github.auth-token") return { stdout: "fixture-token\n", stderr: "", exitCode: 0 };
      if (options.failCapability === spec.capability) return { stdout: "", stderr: "rejected", exitCode: 1 };
      if (spec.capability === "git.execution-import") imported.set(spec.importedRef, spec.expectedObject);
      if (spec.capability === "git.local-verify" && spec.args[2] === "rev-parse" && spec.args.at(-1).startsWith("refs/migration/")) {
        return { stdout: `${imported.get(spec.args.at(-1))}\n`, stderr: "", exitCode: 0 };
      }
      if (spec.capability === "git.push-user-site-cas") {
        state.userSiteRepository.refs["refs/heads/main"] = manifest.userSiteRepository.main.approvedNew;
      }
      if (spec.capability === "git.push-source-atomic") {
        state.sourceRepository.refs["refs/heads/main"] = manifest.sourceRepository.main.approvedNew;
        state.sourceRepository.refs["refs/heads/gh-pages"] = manifest.sourceRepository.ghPages.approvedNew;
        state.sourceRepository.refs["refs/tags/v0.8.3"] = manifest.sourceRepository["v0.8.3"].approvedNewTagObject;
        for (const branch of manifest.sourceRepository.branches) delete state.sourceRepository.refs[`refs/heads/${branch.name}`];
        for (const pull of state.sourceRepository.pullRequests) pull.baseSha = manifest.sourceRepository.main.approvedNew;
        for (const pull of state.sourceRepository.openPullRequests) pull.baseSha = manifest.sourceRepository.main.approvedNew;
        if (options.closePullOnSourcePush !== undefined) {
          state.sourceRepository.pullRequests.find((pull) => pull.number === options.closePullOnSourcePush).state = "closed";
          state.sourceRepository.openPullRequests = state.sourceRepository.openPullRequests.filter((pull) => pull.number !== options.closePullOnSourcePush);
        }
        refreshRefInventories(state);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };

  const fetchAdapter = {
    async request(spec) {
      fetches.push(structuredClone(spec));
      if (spec.capability === "github.rename-repository") {
        state.sourceRepository.name = manifest.sourceRepository.approvedName;
        state.oldSlugRepositoryId = manifest.sourceRepository.repositoryId;
        state.sourceRepository.metadata.homepage = manifest.postconditions.canonicalEndpoint;
        state.sourceRepository.pages.url = manifest.postconditions.canonicalEndpoint;
        return response(200, {});
      }
      if (spec.capability === "github.close-pull-request") {
        const number = Number(new URL(spec.url).pathname.split("/").at(-1));
        state.sourceRepository.pullRequests.find((pull) => pull.number === number).state = "closed";
        state.sourceRepository.openPullRequests = state.sourceRepository.openPullRequests.filter((pull) => pull.number !== number);
        return response(200, {});
      }
      if (spec.capability === "github.configure-repository") {
        state.sourceRepository.metadata.description = manifest.sourceRepository.desiredMetadata.description;
        state.sourceRepository.metadata.homepage = manifest.sourceRepository.desiredMetadata.homepage;
        return response(200, {});
      }
      if (spec.capability === "github.configure-topics") {
        state.sourceRepository.metadata.topics = [...manifest.sourceRepository.desiredMetadata.topics];
        return response(200, {});
      }
      if (spec.capability === "github.configure-pages") {
        const repository = new URL(spec.url).pathname.split("/").slice(2, 4).join("/");
        if (repository === manifest.sourceRepository.approvedName && options.sourcePagesFailureResponse) {
          return options.sourcePagesFailureResponse;
        }
        if (repository === manifest.sourceRepository.approvedName) state.sourceRepository.pages = structuredClone(manifest.sourceRepository.desiredPages);
        else state.userSiteRepository.pages = structuredClone(manifest.userSiteRepository.desiredPages);
        return response(204, undefined);
      }
      if (spec.capability === "pages.read-bytes") {
        if (pageFailures > 0) {
          pageFailures -= 1;
          return response(503, Buffer.from("not ready"));
        }
        if (options.externalRedirect) return response(302, Buffer.alloc(0), { location: "https://evil.example/file" });
        if (redirectRemaining > 0 && !new URL(spec.url).searchParams.has("redirected")) {
          redirectRemaining -= 1;
          const target = new URL(spec.url);
          target.searchParams.set("redirected", "1");
          return response(302, Buffer.alloc(0), { location: target.href });
        }
        const name = decodeURIComponent(new URL(spec.url).pathname.split("/").at(-1));
        const bytes = FILE_BYTES.get(name);
        assert.ok(bytes, `unknown page fixture ${name}`);
        successfulPageReads += 1;
        if (successfulPageReads >= FILE_BYTES.size * 2) state.pages = exactPages(manifest);
        return response(200, bytes);
      }
      throw new Error(`Unexpected fake fetch ${spec.capability}`);
    },
  };

  return {
    state,
    commands,
    fetches,
    sleeps,
    dependencies: {
      command,
      fetch: fetchAdapter,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      clock: monotonicClock(),
      inspectRemote: async () => structuredClone(state),
      verifyLocalEvidence: async () => ({ verified: true }),
      afterMutation: options.afterMutation,
    },
  };
}

function fullyMigrated(manifest, pages = null) {
  const state = oldSnapshot(manifest);
  state.userSiteRepository.refs["refs/heads/main"] = manifest.userSiteRepository.main.approvedNew;
  state.sourceRepository.refs["refs/heads/main"] = manifest.sourceRepository.main.approvedNew;
  state.sourceRepository.refs["refs/heads/gh-pages"] = manifest.sourceRepository.ghPages.approvedNew;
  state.sourceRepository.refs["refs/tags/v0.8.3"] = manifest.sourceRepository["v0.8.3"].approvedNewTagObject;
  for (const branch of manifest.sourceRepository.branches) delete state.sourceRepository.refs[`refs/heads/${branch.name}`];
  state.sourceRepository.name = manifest.sourceRepository.approvedName;
  state.oldSlugRepositoryId = manifest.sourceRepository.repositoryId;
  for (const pull of state.sourceRepository.pullRequests) {
    pull.state = "closed";
    pull.baseSha = manifest.sourceRepository.main.approvedNew;
  }
  state.sourceRepository.openPullRequests = [];
  refreshRefInventories(state);
  state.sourceRepository.metadata = structuredClone(manifest.sourceRepository.desiredMetadata);
  state.sourceRepository.pages = structuredClone(manifest.sourceRepository.desiredPages);
  state.userSiteRepository.pages = structuredClone(manifest.userSiteRepository.desiredPages);
  state.pages = pages;
  return state;
}

function refreshRefInventories(state) {
  state.sourceRepository.ordinaryHeads = Object.entries(state.sourceRepository.refs)
    .filter(([ref, object]) => ref.startsWith("refs/heads/") && object !== null)
    .map(([ref, object]) => ({ ref, object }));
  state.sourceRepository.ordinaryTags = Object.entries(state.sourceRepository.refs)
    .filter(([ref, object]) => ref.startsWith("refs/tags/") && object !== null)
    .map(([ref, object]) => ({ ref, object }));
}

function exactPages(manifest) {
  const files = Object.fromEntries(manifest.postconditions.feedFiles.map((entry) => [entry.name, { bytes: entry.bytes, sha256: entry.sha256 }]));
  return { canonical: { files: structuredClone(files) }, legacy: { files: structuredClone(files) } };
}

function response(status, body, headerValues = {}) {
  return {
    status,
    body,
    headers: { get: (name) => headerValues[name.toLowerCase()] ?? null },
    async json() { return body; },
    async arrayBuffer() { return Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)); },
  };
}

function monotonicClock() {
  let tick = 0;
  return () => `2026-08-08T18:00:${String(tick++).padStart(2, "0")}.000Z`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withWorkspace(callback) {
  const directory = await mkdtemp(join(tmpdir(), "approved-migration-test-"));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("pure validation and push planning produce only exact leased object refspecs", () => {
  const manifest = fixtureManifest();
  validateManifest(manifest, { forApply: true });
  const source = assertPushSafety(buildSourcePush(manifest), manifest);
  const userSite = assertPushSafety(buildUserSitePush(manifest), manifest);
  const sourceCommand = pushCommand(source, manifest);
  const userCommand = pushCommand(userSite, manifest);
  assert.equal(source.atomic, true);
  assert.equal(source.leases.length, manifest.sourceRepository.branches.length + 3);
  assert.equal(source.updates.length, source.leases.length);
  assert.match(sourceCommand.args.join(" "), /--atomic/u);
  assert.doesNotMatch(sourceCommand.args.join(" "), /(?:^|\s)(?:origin|HEAD|--force|-f|--mirror|--all)(?:\s|$)/u);
  assert.equal(userCommand.args.filter((arg) => arg.startsWith("--force-with-lease=")).length, 1);
  assert.throws(() => assertPushSafety({ ...source, atomic: false }, manifest), /exact approved operation/u);
});

test("default verify mode is read-only and returns the exact forward plan", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const harness = fakeHarness(manifest);
  const result = await createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "verify", workspaceRoot });
  assert.equal(result.mode, "verify");
  assert.deepEqual(result.plan.steps.map((step) => step.id), ["preflight", "user-site-main", "source-refs", "rename", "close-pull-requests", "metadata-and-pages", "verify"]);
  assert.equal(harness.commands.length, 0);
  assert.equal(harness.fetches.length, 0);
}));

test("bad hash, approval, eligibility, manifest prerequisites, and live prerequisites cause zero mutation", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const harness = fakeHarness(manifest);
  const executor = createMigrationExecutor(harness.dependencies);
  const input = manifestInput(manifest);
  await assert.rejects(executor.run({ ...input, mode: "apply", expectedManifestSha256: "0".repeat(64), workspaceRoot }), /SHA-256 does not match/u);
  await assert.rejects(executor.run({ ...input, mode: "apply", approvalBytes: Buffer.from("yes\n"), workspaceRoot }), /Approval file contents/u);

  const ineligible = fixtureManifest({ approvalEligible: false });
  await assert.rejects(executor.run({ ...manifestInput(ineligible), mode: "apply", workspaceRoot }), /not approval-eligible/u);
  const notReady = fixtureManifest();
  notReady.prerequisites.ready = false;
  await assert.rejects(executor.run({ ...manifestInput(notReady), mode: "apply", workspaceRoot }), /prerequisites are not ready/u);
  const liveNotReadyHarness = fakeHarness(manifest);
  liveNotReadyHarness.state.prerequisites.ready = false;
  await assert.rejects(createMigrationExecutor(liveNotReadyHarness.dependencies).run({ ...input, mode: "apply", workspaceRoot }), /not verified ready/u);
  assert.equal(harness.commands.length + harness.fetches.length, 0);
  assert.equal(liveNotReadyHarness.commands.length + liveNotReadyHarness.fetches.length, 0);
}));

test("weakened prerequisite declarations fail before any command, fetch, or remote inspection", async () => withWorkspace(async (workspaceRoot) => {
  const cases = [
    {
      mutate: (manifest) => { manifest.prerequisites.requiredEnvironments = []; },
      error: /required environments are not exact/u,
    },
    {
      mutate: (manifest) => { manifest.prerequisites.requiredEnvironmentSecrets["release-signing"] = []; },
      error: /release-signing secrets are not exact/u,
    },
    {
      mutate: (manifest) => { manifest.prerequisites.requiredVariables.LEGACY_FEED_APP_ID = "<numeric-dedicated-app-id>"; },
      error: /numeric LEGACY_FEED_APP_ID/u,
    },
    {
      mutate: (manifest) => { manifest.prerequisites.requiredLegacyFeedApp.permissions.contents = "read"; },
      error: /exactly Metadata read and Contents write/u,
    },
    {
      mutate: (manifest) => { manifest.prerequisites.missingAtCapture = ["unresolved"]; },
      error: /may not contain missing gaps/u,
    },
  ];
  for (const scenario of cases) {
    const manifest = fixtureManifest();
    scenario.mutate(manifest);
    const harness = fakeHarness(manifest);
    let inspected = 0;
    harness.dependencies.inspectRemote = async () => { inspected += 1; return structuredClone(harness.state); };
    await assert.rejects(createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), scenario.error);
    assert.equal(inspected, 0);
    assert.equal(harness.commands.length + harness.fetches.length, 0);
  }
}));

test("a changed deferred protection branch fails before any command, fetch, or remote inspection", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  manifest.deferredGates.repositoryProtections.branch = "release";
  const harness = fakeHarness(manifest);
  let inspected = 0;
  harness.dependencies.inspectRemote = async () => { inspected += 1; return structuredClone(harness.state); };
  await assert.rejects(
    createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }),
    /post-cutover, pre-release deferred gate/u,
  );
  assert.equal(inspected, 0);
  assert.equal(harness.commands.length + harness.fetches.length, 0);
}));

test("App private-key loading signs bounded RS256 JWTs and rejects missing, symlink, or invalid keys before network", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const keyDirectory = await realpath(await mkdtemp(join(tmpdir(), "legacy-feed-app-key-test-")));
  try {
    const keyPath = join(keyDirectory, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const validPem = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
    await writeFile(keyPath, validPem);
    const authentication = await loadLegacyFeedAppAuthentication({
      privateKeyPath: keyPath,
      workspaceRoot,
      appId: 424242,
      clock: () => "2026-08-08T18:00:00.000Z",
    });
    const jwt = authentication.createJwt();
    const [header, payload, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    assert.equal(claims.iss, "424242");
    assert.equal(claims.exp - claims.iat, 540);
    assert.ok(signature.length > 100);

    const invalidPath = join(keyDirectory, "invalid.pem");
    await writeFile(invalidPath, "x".repeat(300));
    const cases = [
      {
        path: undefined,
        loader: loadLegacyFeedAppAuthentication,
        error: /explicit absolute/u,
      },
      {
        path: join(keyDirectory, "missing.pem"),
        loader: loadLegacyFeedAppAuthentication,
        error: /missing, unreadable/u,
      },
      {
        path: invalidPath,
        loader: loadLegacyFeedAppAuthentication,
        error: /not a valid private key/u,
      },
      {
        path: keyPath,
        loader: (args) => loadLegacyFeedAppAuthentication({
          ...args,
          fileSystem: {
            realpath: async (path) => path,
            open: async () => ({
              stat: async () => ({ dev: 1n, ino: 1n, size: BigInt(validPem.length), mtimeNs: 1n, ctimeNs: 1n, isFile: () => true }),
              readFile: async () => { throw new Error("must not read symlink"); },
              close: async () => undefined,
            }),
            lstat: async () => ({ isFile: () => false, isSymbolicLink: () => true }),
            stat: async () => { throw new Error("must not stat symlink target"); },
          },
        }),
        error: /regular non-symlink/u,
      },
      {
        path: keyPath,
        loader: (args) => loadLegacyFeedAppAuthentication({
          ...args,
          fileSystem: {
            realpath: async (path) => path,
            open: async () => ({
              stat: async () => ({ dev: 1n, ino: 1n, size: BigInt(validPem.length), mtimeNs: 1n, ctimeNs: 1n, isFile: () => true }),
              readFile: async () => validPem,
              close: async () => undefined,
            }),
            lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
            stat: async () => ({ dev: 1n, ino: 2n, size: BigInt(validPem.length), mtimeNs: 1n, ctimeNs: 1n, isFile: () => true }),
          },
        }),
        error: /changed while it was being opened/u,
      },
    ];
    for (const scenario of cases) {
      let network = 0;
      let localEvidence = 0;
      const executor = createMigrationExecutor({
        command: { async run() { throw new Error("command must not run"); } },
        fetch: { async request() { network += 1; throw new Error("network must not run"); } },
        verifyLocalEvidence: async () => { localEvidence += 1; },
        loadLegacyFeedAppAuthentication: scenario.loader,
      });
      await assert.rejects(executor.run({
        ...manifestInput(manifest),
        mode: "verify",
        workspaceRoot,
        legacyFeedAppPrivateKeyPath: scenario.path,
      }), scenario.error);
      assert.equal(network, 0);
      assert.equal(localEvidence, 0);
    }
  } finally {
    await rm(keyDirectory, { recursive: true, force: true });
  }
}));

test("tag drift and stale leased push fail closed", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const driftHarness = fakeHarness(manifest);
  driftHarness.state.sourceRepository.refs["refs/tags/v0.8.3"] = "f".repeat(40);
  await assert.rejects(createMigrationExecutor(driftHarness.dependencies).run({ ...manifestInput(manifest), mode: "verify", workspaceRoot }), /Unapproved remote value.*tag/u);
  assert.equal(driftHarness.commands.length + driftHarness.fetches.length, 0);

  const staleHarness = fakeHarness(manifest, { failCapability: "git.push-user-site-cas" });
  await assert.rejects(createMigrationExecutor(staleHarness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), /failed with exit code 1/u);
  assert.equal(staleHarness.state.userSiteRepository.refs["refs/heads/main"], manifest.userSiteRepository.main.expectedOld);
  assert.equal(staleHarness.commands.filter((entry) => entry.capability.startsWith("git.push")).length, 1);
}));

test("full apply emits the exact CAS/atomic transcript and reaches pinned postconditions", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const harness = fakeHarness(manifest);
  const result = await createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot });
  assert.equal(result.state.complete, true);
  const pushes = harness.commands.filter((entry) => entry.capability.startsWith("git.push"));
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[0].args, [...pushCommand(buildUserSitePush(manifest), manifest).args]);
  assert.deepEqual(pushes[1].args, [...pushCommand(buildSourcePush(manifest), manifest).args]);
  assert.equal(harness.fetches.filter((entry) => entry.capability === "github.rename-repository").length, 1);
  assert.equal(harness.fetches.filter((entry) => entry.capability === "github.close-pull-request").length, manifest.sourceRepository.pullRequestsToClose.length);
  const pagesMutations = harness.fetches.filter((entry) => entry.capability === "github.configure-pages");
  assert.equal(pagesMutations.length, 1);
  assert.deepEqual(pagesMutations[0].body, { build_type: "workflow" });
  assert.equal("cname" in pagesMutations[0].body, false);
  assert.equal("https_enforced" in pagesMutations[0].body, false);
  assert.equal(harness.state.sourceRepository.pages.cname, null);
  assert.equal(harness.state.sourceRepository.pages.httpsEnforced, true);
  assert.equal(harness.state.sourceRepository.repositoryId, manifest.sourceRepository.repositoryId);
  assert.deepEqual(harness.state.sourceRepository.release.assets, manifest.release.assets);
  const journal = await readFile(join(workspaceRoot, manifest.execution.journalPath), "utf8");
  assert.match(journal, /"event":"run-verified"/u);
}));

test("GitHub mutation failures report only bounded allowlisted diagnostics", async () => {
  let arrayBufferCalls = 0;
  let hangingReaderCancellations = 0;
  let zeroChunkReads = 0;
  let zeroChunkCancellations = 0;
  const githubTokenFixture = (suffix) => ["gh", `p_${suffix}`].join("");
  const bearerFixture = (suffix) => ["Bearer", githubTokenFixture(suffix)].join(" ");
  const credentialMessages = [
    ["40-character hex", "0123456789abcdef0123456789abcdef01234567"],
    ["base64 credential", "c2VjcmV0LWNsaWVudC1jcmVkZW50aWFsLXRva2VuLWJ5dGVz"],
    ["random credential", ["sk", "live", "F7sQ9vW2xN4mK8pR6tY3uH5jL1cB0dA"].join("_")],
  ];
  const emptyCategories = {
    pages: false,
    "not-enabled": false,
    "not-found": false,
    workflow: false,
    branch: false,
    permission: false,
    access: false,
    repository: false,
    endpoint: false,
  };
  const redactedMetadata = (message, categories = emptyCategories) => ({
    normalizedUtf8Bytes: Buffer.byteLength(message, "utf8"),
    sha256: sha256(Buffer.from(message, "utf8")),
    categories,
  });
  const cases = [
    {
      name: "safe JSON",
      response: () => new Response(JSON.stringify({
        message: "Not Found",
        documentation_url: "https://docs.github.com/rest/pages/pages#update-information-about-a-github-pages-site",
        ignored: "must-not-be-reported",
      }), {
        status: 404,
        headers: {
          "x-github-request-id": "ABCD:1234:EF56",
          "x-oauth-scopes": "repo, workflow",
          "x-accepted-oauth-scopes": "repo",
        },
      }),
      verify(error) {
        assert.match(error.message, /github\.configure-pages returned HTTP 404/u);
        assert.match(error.message, /GitHub message="Not Found"/u);
        assert.match(error.message, /documentation_url="https:\/\/docs\.github\.com\/rest\/pages\/pages#update-information-about-a-github-pages-site"/u);
        assert.match(error.message, /X-GitHub-Request-Id="ABCD:1234:EF56"/u);
        assert.match(error.message, /X-OAuth-Scopes="repo, workflow"/u);
        assert.match(error.message, /X-Accepted-OAuth-Scopes="repo"/u);
        assert.doesNotMatch(error.message, /message_metadata=/u);
        assert.doesNotMatch(error.message, /must-not-be-reported/u);
      },
    },
    {
      name: "redacted category metadata",
      message: "GitHub Pages is not enabled; workflow branch cannot be found for this repository because permission access failed at endpoint",
      response() {
        return new Response(JSON.stringify({ message: this.message }), {
          status: 404,
          headers: { "x-github-request-id": "CATEGORY:1" },
        });
      },
      verify(error) {
        const expected = redactedMetadata(this.message, {
          pages: true,
          "not-enabled": true,
          "not-found": true,
          workflow: true,
          branch: true,
          permission: true,
          access: true,
          repository: true,
          endpoint: true,
        });
        assert.match(error.message, /GitHub message="\[redacted\]"/u);
        assert.ok(error.message.includes(`message_metadata=${JSON.stringify(expected)}`), error.message);
        assert.doesNotMatch(error.message, /GitHub Pages is not enabled/u);
      },
    },
    {
      name: "malformed JSON",
      response: () => new Response("{malformed ghp_body_secret_1234567890", {
        status: 404,
        headers: { "x-github-request-id": "MALFORMED:1", "x-accepted-oauth-scopes": "" },
      }),
      verify(error) {
        assert.match(error.message, /body=malformed/u);
        assert.match(error.message, /X-GitHub-Request-Id="MALFORMED:1"/u);
        assert.match(error.message, /X-Accepted-OAuth-Scopes="<empty>"/u);
        assert.doesNotMatch(error.message, /ghp_body_secret/u);
      },
    },
    {
      name: "arrayBuffer-only adapter",
      response: () => ({
        status: 404,
        body: null,
        headers: new Headers({ "x-github-request-id": "ARRAYBUFFER:1" }),
        async arrayBuffer() {
          arrayBufferCalls += 1;
          return Buffer.alloc(1_000_000, 0x61);
        },
      }),
      verify(error) {
        assert.match(error.message, /body=unavailable/u);
        assert.match(error.message, /X-GitHub-Request-Id="ARRAYBUFFER:1"/u);
        assert.equal(arrayBufferCalls, 0);
      },
    },
    {
      name: "hanging stream reader",
      response: () => ({
        status: 404,
        headers: new Headers({ "x-github-request-id": "HANGING:1" }),
        body: {
          getReader() {
            return {
              read: () => new Promise(() => undefined),
              cancel() {
                hangingReaderCancellations += 1;
                return Promise.resolve();
              },
            };
          },
        },
      }),
      verify(error) {
        assert.match(error.message, /body=unavailable-timeout/u);
        assert.equal(hangingReaderCancellations, 1);
      },
    },
    {
      name: "endless zero-length chunks",
      response: () => ({
        status: 404,
        headers: new Headers({ "x-github-request-id": "ZERO:1" }),
        body: {
          getReader() {
            return {
              read() {
                zeroChunkReads += 1;
                return Promise.resolve({ done: false, value: new Uint8Array(0) });
              },
              cancel() {
                zeroChunkCancellations += 1;
                return Promise.resolve();
              },
            };
          },
        },
      }),
      verify(error) {
        assert.match(error.message, /body=unavailable-read-limit/u);
        assert.equal(zeroChunkReads, 64);
        assert.equal(zeroChunkCancellations, 1);
      },
    },
    {
      name: "oversized JSON",
      response: () => new Response(JSON.stringify({ message: `Not Found ${"x".repeat(9_000)} ghp_oversized_secret_1234567890` }), {
        status: 404,
        headers: { "x-github-request-id": "OVERSIZED:1" },
      }),
      verify(error) {
        assert.match(error.message, /body=redacted-oversized/u);
        assert.match(error.message, /X-GitHub-Request-Id="OVERSIZED:1"/u);
        assert.doesNotMatch(error.message, /ghp_oversized_secret/u);
      },
    },
    {
      name: "sensitive JSON",
      response: () => new Response(JSON.stringify({
        message: `authorization=${bearerFixture("message_secret_1234567890")}`,
        documentation_url: "https://docs.github.com/rest/pages#token%3Dghp_url_secret_1234567890",
        token: "ghp_field_secret_1234567890",
        errors: [{ secret: "ghp_nested_secret_1234567890" }],
      }), {
        status: 404,
        headers: {
          "x-github-request-id": "SENSITIVE:1",
          "x-oauth-scopes": "repo, workflow",
          authorization: bearerFixture("header_secret_1234567890"),
        },
      }),
      verify(error) {
        assert.match(error.message, /GitHub message="\[redacted\]"/u);
        assert.match(error.message, /X-OAuth-Scopes="repo, workflow"/u);
        assert.doesNotMatch(error.message, /documentation_url=/u);
        assert.doesNotMatch(error.message, /ghp_|Bearer|token=|nested_secret|header_secret/u);
      },
    },
    ...credentialMessages.map(([name, credential]) => ({
      name,
      response: () => new Response(JSON.stringify({ message: credential }), {
        status: 404,
        headers: { "x-github-request-id": "CREDENTIAL:1" },
      }),
      verify(error) {
        assert.match(error.message, /GitHub message="\[redacted\]"/u);
        assert.doesNotMatch(error.message, new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        assert.ok(error.message.includes(`message_metadata=${JSON.stringify(redactedMetadata(credential))}`));
      },
    })),
  ];

  for (const scenario of cases) {
    await withWorkspace(async (workspaceRoot) => {
      const manifest = fixtureManifest();
      const harness = fakeHarness(manifest, { sourcePagesFailureResponse: scenario.response() });
      await assert.rejects(
        createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }),
        (error) => {
          scenario.verify(error);
          return true;
        },
        scenario.name,
      );
      assert.equal(harness.fetches.filter((entry) => entry.capability === "github.configure-pages").length, 1);
    });
  }
});

test("a crash after an atomic push resumes from remote truth without replaying mutations", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  let crash = true;
  const harness = fakeHarness(manifest, {
    afterMutation: ({ step }) => {
      if (step === "source-refs" && crash) {
        crash = false;
        throw new Error("injected crash");
      }
    },
  });
  const input = { ...manifestInput(manifest), mode: "apply", workspaceRoot };
  await assert.rejects(createMigrationExecutor(harness.dependencies).run(input), /injected crash/u);
  assert.equal(harness.state.userSiteRepository.refs["refs/heads/main"], manifest.userSiteRepository.main.approvedNew);
  assert.equal(harness.state.sourceRepository.refs["refs/heads/main"], manifest.sourceRepository.main.approvedNew);
  const resumed = await createMigrationExecutor(harness.dependencies).run(input);
  assert.equal(resumed.state.complete, true);
  assert.equal(harness.commands.filter((entry) => entry.capability === "git.push-user-site-cas").length, 1);
  assert.equal(harness.commands.filter((entry) => entry.capability === "git.push-source-atomic").length, 1);
  assert.match(await readFile(join(workspaceRoot, manifest.execution.journalPath), "utf8"), /"event":"step-recovered"/u);
}));

test("a crash after an individual PR or metadata API write resumes without replaying that write", async () => {
  const manifest = fixtureManifest();
  const firstPull = manifest.sourceRepository.pullRequestsToClose[0].number;
  const cases = [
    {
      step: "rename",
      capability: "github.rename-repository",
      matches: (entry) => new URL(entry.url).pathname.endsWith(`/${manifest.sourceRepository.currentName}`),
    },
    {
      step: `close-pull-request:${firstPull}`,
      capability: "github.close-pull-request",
      matches: (entry) => entry.url.endsWith(`/pulls/${firstPull}`),
    },
    {
      step: "configure-repository-metadata",
      capability: "github.configure-repository",
      matches: () => true,
    },
    {
      step: "configure-source-pages",
      capability: "github.configure-pages",
      matches: (entry) => new URL(entry.url).pathname.includes(`/${manifest.sourceRepository.approvedName}/pages`),
    },
  ];
  for (const scenario of cases) {
    await withWorkspace(async (workspaceRoot) => {
      let crash = true;
      const harness = fakeHarness(manifest, {
        afterMutation: ({ step }) => {
          if (step === scenario.step && crash) {
            crash = false;
            throw new Error(`injected crash after ${step}`);
          }
        },
      });
      const input = { ...manifestInput(manifest), mode: "apply", workspaceRoot };
      await assert.rejects(createMigrationExecutor(harness.dependencies).run(input), /injected crash/u);
      const resumed = await createMigrationExecutor(harness.dependencies).run(input);
      assert.equal(resumed.state.complete, true);
      assert.equal(harness.fetches.filter((entry) => entry.capability === scenario.capability && scenario.matches(entry)).length, 1);
      assert.match(await readFile(join(workspaceRoot, manifest.execution.journalPath), "utf8"), new RegExp(`"event":"step-recovered".*"id":"${scenario.step}"`, "u"));
    });
  }
});

test("a PR closed as a source-push side effect is journaled as a replay-valid recovered no-op", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const closedByPush = manifest.sourceRepository.pullRequestsToClose[0].number;
  const harness = fakeHarness(manifest, { closePullOnSourcePush: closedByPush });
  const executor = createMigrationExecutor(harness.dependencies);
  const input = { ...manifestInput(manifest), mode: "apply", workspaceRoot };
  const first = await executor.run(input);
  const second = await executor.run(input);
  assert.equal(first.state.complete, true);
  assert.equal(second.verificationOnly, true);
  assert.equal(harness.fetches.filter((entry) => entry.capability === "github.close-pull-request" && entry.url.endsWith(`/pulls/${closedByPush}`)).length, 0);
  assert.match(await readFile(join(workspaceRoot, manifest.execution.journalPath), "utf8"), new RegExp(`"event":"step-recovered".*"id":"close-pull-request:${closedByPush}"`, "u"));
}));

test("extra ordinary head, ordinary tag, or open pull request aborts before mutation", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const cases = [
    (state) => {
      state.sourceRepository.refs["refs/heads/unapproved"] = "a".repeat(40);
      state.sourceRepository.ordinaryHeads.push({ ref: "refs/heads/unapproved", object: "a".repeat(40) });
    },
    (state) => {
      state.sourceRepository.refs["refs/tags/unapproved"] = "b".repeat(40);
      state.sourceRepository.ordinaryTags.push({ ref: "refs/tags/unapproved", object: "b".repeat(40) });
    },
    (state) => {
      state.sourceRepository.openPullRequests.push({
        number: 999,
        nodeId: "PR_unapproved",
        state: "open",
        baseRef: "main",
        baseSha: manifest.sourceRepository.main.expectedOld,
        headRef: "unapproved",
        headSha: "c".repeat(40),
      });
    },
  ];
  for (const mutate of cases) {
    const harness = fakeHarness(manifest);
    mutate(harness.state);
    await assert.rejects(createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), /Unexpected (?:ordinary|open)|inventory size/u);
    assert.equal(harness.commands.length + harness.fetches.length, 0);
  }
}));

test("bounded pagination refuses to silently truncate a 2,000-item inventory", async () => {
  const manifest = fixtureManifest();
  let calls = 0;
  const fetchAdapter = {
    async request() {
      calls += 1;
      return response(200, Array.from({ length: 100 }, (_, index) => ({ ref: `refs/heads/${calls}-${index}` })));
    },
  };
  await assert.rejects(apiListPaginated(fetchAdapter, { manifest }, manifest.sourceRepository.currentName, "/git/matching-refs/heads/", null), /exceeded.*20-page bound/u);
  assert.equal(calls, 20);
});

test("GitHub read allowlist admits only the exact pinned numeric repository endpoint", () => {
  const manifest = fixtureManifest();
  const path = `/repositories/${manifest.sourceRepository.repositoryId}`;
  const spec = {
    capability: "github.read",
    method: "GET",
    url: `https://api.github.com${path}`,
    redirect: "manual",
    timeoutMs: 20_000,
    headers: { accept: "application/vnd.github+json" },
  };
  assert.equal(assertFetchAllowed(spec, { manifest }), spec);

  const rejected = [
    { ...spec, url: `https://api.github.com/repositories/${manifest.sourceRepository.repositoryId + 1}` },
    { ...spec, url: `${spec.url}/topics` },
    { ...spec, url: `${spec.url}?page=1` },
    { ...spec, url: `https://api.github.com:444${path}` },
    { ...spec, body: {} },
    { ...spec, capability: "github.rename-repository", method: "PATCH", body: { name: "kimi-code-desktop" } },
  ];
  for (const candidate of rejected) {
    assert.throws(() => assertFetchAllowed(candidate, { manifest }), /allowlist/u);
  }
});

test("old source slug may redirect to its exact pinned numeric repository endpoint", async () => {
  const manifest = fixtureManifest();
  const requests = [];
  const numericPath = `/repositories/${manifest.sourceRepository.repositoryId}`;
  const fetchAdapter = {
    async request(spec) {
      requests.push(structuredClone(spec));
      const path = new URL(spec.url).pathname;
      if (path === `/repos/${manifest.sourceRepository.currentName}`) {
        return response(301, {}, { location: `https://api.github.com${numericPath}` });
      }
      if (path === numericPath) {
        return response(200, { id: manifest.sourceRepository.repositoryId, full_name: manifest.sourceRepository.approvedName });
      }
      throw new Error(`Unexpected redirect fixture URL ${spec.url}`);
    },
  };

  const repository = await apiGetFollowingRedirects(fetchAdapter, { manifest }, manifest.sourceRepository.currentName, "", 3);
  assert.equal(repository.id, manifest.sourceRepository.repositoryId);
  assert.equal(repository.full_name, manifest.sourceRepository.approvedName);
  assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
    `/repos/${manifest.sourceRepository.currentName}`,
    numericPath,
  ]);
  assert.equal(requests.every((entry) => entry.capability === "github.read" && entry.method === "GET" && entry.body === undefined), true);
});

test("legacy-feed App discovery uses App JWT and installation-token scope without gh OAuth endpoints", async () => {
  const manifest = fixtureManifest();
  const requests = [];
  const target = {
    id: 4242,
    app_id: 424242,
    repository_selection: "selected",
    permissions: { metadata: "read", contents: "write" },
  };
  const fetchAdapter = {
    async request(spec) {
      requests.push(structuredClone(spec));
      const url = new URL(spec.url);
      if (url.pathname.startsWith("/user/installations")) return response(403, { message: "Resource not accessible by integration" });
      if (url.pathname === "/app/installations") return response(200, [target]);
      if (url.pathname === "/app/installations/4242/access_tokens") {
        return response(201, {
          token: "ghs_fixture_installation_token",
          expires_at: "2026-08-08T18:55:00.000Z",
          repository_selection: "selected",
          permissions: { metadata: "read", contents: "write" },
        });
      }
      if (url.pathname === "/installation/repositories") {
        return response(200, { total_count: 1, repositories: [{ id: manifest.userSiteRepository.repositoryId }] });
      }
      throw new Error(`Unexpected App fixture URL ${url.href}`);
    },
  };
  const context = {
    manifest,
    clock: () => "2026-08-08T18:00:00.000Z",
    appAuthentication: { appId: 424242, createJwt: () => "fixtureHeader.fixturePayload.fixtureSignature" },
  };
  const result = await inspectLegacyFeedApp(fetchAdapter, context, 424242);
  assert.deepEqual(result, { ready: true, installationId: 4242, repositories: [manifest.userSiteRepository.repositoryId] });
  assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
    "/app/installations",
    "/app/installations/4242/access_tokens",
    "/installation/repositories",
  ]);
  assert.equal(requests.some((entry) => new URL(entry.url).pathname.startsWith("/user/installations")), false);
  assert.deepEqual(requests.map((entry) => entry.capability), [
    "github.read-app-installations",
    "github.create-installation-token",
    "github.read-installation-repositories",
  ]);
  const widenedScope = await inspectLegacyFeedApp({
    async request(spec) {
      const url = new URL(spec.url);
      if (url.pathname === "/app/installations") return response(200, [target]);
      if (url.pathname.endsWith("/access_tokens")) {
        return response(201, {
          token: "ghs_fixture_installation_token",
          expires_at: "2026-08-08T18:55:00.000Z",
          repository_selection: "selected",
          permissions: { metadata: "read", contents: "write" },
        });
      }
      return response(200, {
        total_count: 2,
        repositories: [{ id: manifest.userSiteRepository.repositoryId }, { id: manifest.sourceRepository.repositoryId }],
      });
    },
  }, context, 424242);
  assert.equal(widenedScope.ready, false);

  const decoys = Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, app_id: 500000 + index }));
  let pages = 0;
  const multipleInstallations = await inspectLegacyFeedApp({
    async request(spec) {
      pages += 1;
      return response(200, pages === 1 ? decoys : [target]);
    },
  }, context, 424242);
  assert.equal(multipleInstallations.ready, false);
  assert.equal(pages, 2);
});

test("captured GitHub Pages responses distinguish the root site URL from the legacy feed path", () => {
  const manifest = fixtureManifest();
  const snapshot = oldSnapshot(manifest);
  snapshot.sourceRepository.pages = normalizePages({
    build_type: "legacy",
    source: { branch: "gh-pages", path: "/" },
    cname: null,
    https_enforced: true,
    html_url: "https://leonxlnx.github.io/tasty-desktop/",
  });
  snapshot.userSiteRepository.pages = normalizePages({
    build_type: "legacy",
    source: { branch: "main", path: "/" },
    cname: null,
    https_enforced: true,
    html_url: "https://leonxlnx.github.io/",
  });
  const initial = classifyState(manifest, snapshot);
  assert.equal(initial.userSitePages, true);
  assert.equal(initial.sourcePages, false);
  assert.equal(initial.complete, false);
  const migrated = fullyMigrated(manifest, exactPages(manifest));
  migrated.userSiteRepository.pages = normalizePages({
    build_type: "legacy",
    source: { branch: "main", path: "/" },
    cname: null,
    https_enforced: true,
    html_url: "https://leonxlnx.github.io/",
  });
  assert.equal(classifyState(manifest, migrated).complete, true);
  migrated.userSiteRepository.pages.url = manifest.postconditions.legacyEndpoint;
  assert.throws(() => classifyState(manifest, migrated), /user-site Pages configuration differs/u);
  const wrongManifest = fixtureManifest();
  wrongManifest.userSiteRepository.desiredPages.url = wrongManifest.postconditions.legacyEndpoint;
  assert.throws(() => validateManifest(wrongManifest), /user-site desired Pages configuration is not exact/u);
});

test("only redirect-proven rename side effects classify as incomplete metadata and Pages", () => {
  const manifest = fixtureManifest();
  const renamed = fullyMigrated(manifest);
  renamed.sourceRepository.metadata = {
    ...structuredClone(manifest.capturedInitialState.sourceRepository.metadata),
    homepage: manifest.postconditions.canonicalEndpoint,
  };
  renamed.sourceRepository.pages = {
    ...structuredClone(manifest.capturedInitialState.sourceRepository.pages),
    url: manifest.postconditions.canonicalEndpoint,
  };
  const state = classifyState(manifest, renamed);
  assert.equal(state.rename, "new");
  assert.equal(state.redirect, true);
  assert.equal(state.repositoryMetadata, false);
  assert.equal(state.repositoryTopics, false);
  assert.equal(state.sourcePages, false);
  assert.equal(state.metadata, false);
  assert.equal(state.complete, false);

  const preRename = oldSnapshot(manifest);
  preRename.sourceRepository.metadata = structuredClone(renamed.sourceRepository.metadata);
  preRename.sourceRepository.pages = structuredClone(renamed.sourceRepository.pages);
  assert.throws(() => classifyState(manifest, preRename), /source repository metadata differs/u);

  const missingRedirect = structuredClone(renamed);
  missingRedirect.oldSlugRepositoryId = null;
  assert.throws(() => classifyState(manifest, missingRedirect), /Old source slug does not redirect/u);

  const metadataDrift = structuredClone(renamed);
  metadataDrift.sourceRepository.metadata.description = "unapproved rename side effect";
  assert.throws(() => classifyState(manifest, metadataDrift), /source repository metadata differs/u);

  const pagesDrift = structuredClone(renamed);
  pagesDrift.sourceRepository.pages.source = { branch: "main", path: "/" };
  assert.throws(() => classifyState(manifest, pagesDrift), /source Pages configuration differs/u);
});

test("empty or malformed journal cannot authorize an unjournaled remote prefix", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const input = { ...manifestInput(manifest), mode: "apply", workspaceRoot };

  const unjournaled = fakeHarness(manifest);
  unjournaled.state.userSiteRepository.refs["refs/heads/main"] = manifest.userSiteRepository.main.approvedNew;
  await assert.rejects(createMigrationExecutor(unjournaled.dependencies).run(input), /empty journal accepts only/u);
  assert.equal(unjournaled.commands.length + unjournaled.fetches.length, 0);

  for (const seed of [
    async (log) => log.append("step-started", { id: "source-refs" }),
    async (log) => log.append("step-completed", { id: "user-site-main", state: classifyState(manifest, oldSnapshot(manifest)) }),
  ]) {
    const isolatedWorkspace = await mkdtemp(join(tmpdir(), "journal-order-test-"));
    try {
      const harness = fakeHarness(manifest);
      const isolatedInput = { ...manifestInput(manifest), mode: "apply", workspaceRoot: isolatedWorkspace };
      const path = join(isolatedWorkspace, manifest.execution.journalPath);
      await createFileJournalAdapter().withExclusive(path, isolatedInput.expectedManifestSha256, monotonicClock(), seed);
      await assert.rejects(createMigrationExecutor(harness.dependencies).run(isolatedInput), /before user-site-main|no matching terminal step-started/u);
      assert.equal(harness.commands.length + harness.fetches.length, 0);
    } finally {
      await rm(isolatedWorkspace, { recursive: true, force: true });
    }
  }
}));

test("every active workflow status blocks apply before authentication or mutation", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  for (const [index, status] of ["queued", "in_progress", "waiting", "pending", "requested", "action_required"].entries()) {
    const harness = fakeHarness(manifest);
    harness.state.prerequisites.activeWorkflowRuns = [{ id: 7000 + index, status }];
    await assert.rejects(createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), new RegExp(status, "u"));
    assert.equal(harness.commands.length + harness.fetches.length, 0);
  }
}));

test("workflow freeze is rechecked under the lock between irreversible steps", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const harness = fakeHarness(manifest);
  const baseInspect = harness.dependencies.inspectRemote;
  harness.dependencies.inspectRemote = async (...args) => {
    if (harness.state.userSiteRepository.refs["refs/heads/main"] === manifest.userSiteRepository.main.approvedNew
      && harness.state.sourceRepository.refs["refs/heads/main"] === manifest.sourceRepository.main.expectedOld) {
      harness.state.prerequisites.activeWorkflowRuns = [{ id: 8800, status: "queued" }];
    }
    return baseInspect(...args);
  };
  await assert.rejects(createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), /queued/u);
  assert.equal(harness.commands.filter((entry) => entry.capability === "git.push-user-site-cas").length, 1);
  assert.equal(harness.commands.filter((entry) => entry.capability === "git.push-source-atomic").length, 0);
}));

test("workflow freeze is rechecked between individual PR and metadata API writes", async () => {
  const manifest = fixtureManifest();
  const cases = [
    {
      status: "requested",
      activated: (state) => state.sourceRepository.pullRequests.some((pull) => pull.state === "closed")
        && state.sourceRepository.pullRequests.some((pull) => pull.state === "open"),
      firstCapability: "github.close-pull-request",
      blockedCapability: "github.configure-repository",
    },
    {
      status: "waiting",
      activated: (state) => state.sourceRepository.metadata.description === manifest.sourceRepository.desiredMetadata.description
        && state.sourceRepository.metadata.topics.join("\0") !== manifest.sourceRepository.desiredMetadata.topics.join("\0"),
      firstCapability: "github.configure-repository",
      blockedCapability: "github.configure-topics",
    },
  ];
  for (const scenario of cases) {
    await withWorkspace(async (workspaceRoot) => {
      const harness = fakeHarness(manifest);
      const baseInspect = harness.dependencies.inspectRemote;
      harness.dependencies.inspectRemote = async (...args) => {
        if (scenario.activated(harness.state)) {
          harness.state.prerequisites.activeWorkflowRuns = [{ id: 9900, status: scenario.status }];
        }
        return baseInspect(...args);
      };
      await assert.rejects(createMigrationExecutor(harness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), new RegExp(scenario.status, "u"));
      assert.equal(harness.fetches.filter((entry) => entry.capability === scenario.firstCapability).length, 1);
      assert.equal(harness.fetches.filter((entry) => entry.capability === scenario.blockedCapability).length, 0);
    });
  }
});

test("pinned PR or repository identity mismatch aborts before mutation", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const prHarness = fakeHarness(manifest);
  prHarness.state.sourceRepository.pullRequests[0].nodeId = "PR_wrong";
  await assert.rejects(createMigrationExecutor(prHarness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), /identity drifted/u);
  const repoHarness = fakeHarness(manifest);
  repoHarness.state.sourceRepository.name = manifest.sourceRepository.approvedName;
  repoHarness.state.sourceRepository.repositoryId += 1;
  await assert.rejects(createMigrationExecutor(repoHarness.dependencies).run({ ...manifestInput(manifest), mode: "apply", workspaceRoot }), /repository identity differs/u);
  assert.equal(prHarness.commands.length + prHarness.fetches.length + repoHarness.commands.length + repoHarness.fetches.length, 0);
}));

test("Pages verification retries, follows only bounded same-host redirects, and times out closed", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const retryHarness = fakeHarness(manifest, { state: fullyMigrated(manifest), pageFailures: 1, redirectOnce: true });
  const result = await createMigrationExecutor(retryHarness.dependencies).run({ ...manifestInput(manifest), mode: "verify", workspaceRoot });
  assert.equal(result.verificationOnly, true);
  assert.deepEqual(retryHarness.sleeps, [1000]);
  assert.equal(retryHarness.fetches.some((entry) => new URL(entry.url).searchParams.has("redirected")), true);
  assert.equal(retryHarness.commands.length, 0);

  const redirectHarness = fakeHarness(manifest, { state: fullyMigrated(manifest), externalRedirect: true });
  await assert.rejects(createMigrationExecutor(redirectHarness.dependencies).run({ ...manifestInput(manifest), mode: "verify", workspaceRoot }), /timed out.*escaped the approved host/u);
  assert.equal(redirectHarness.sleeps.length, 5);
  assert.equal(redirectHarness.commands.length, 0);
}));

test("third run is verification-only and does not append or replay mutation journal entries", async () => withWorkspace(async (workspaceRoot) => {
  const manifest = fixtureManifest();
  const harness = fakeHarness(manifest);
  const executor = createMigrationExecutor(harness.dependencies);
  const input = { ...manifestInput(manifest), mode: "apply", workspaceRoot };
  await executor.run(input);
  const journalPath = join(workspaceRoot, manifest.execution.journalPath);
  const afterFirst = await readFile(journalPath);
  const mutationsAfterFirst = harness.commands.length + harness.fetches.filter((entry) => entry.capability.startsWith("github.")).length;
  const second = await executor.run(input);
  const third = await executor.run(input);
  assert.equal(second.verificationOnly, true);
  assert.equal(third.verificationOnly, true);
  assert.deepEqual(await readFile(journalPath), afterFirst);
  assert.equal(harness.commands.length + harness.fetches.filter((entry) => entry.capability.startsWith("github.")).length, mutationsAfterFirst);
}));

test("hash-chained journal is exclusive, append-only, and rejects tampering", async () => withWorkspace(async (workspaceRoot) => {
  const path = join(workspaceRoot, "journal.jsonl");
  const adapter = createFileJournalAdapter();
  const hash = "a".repeat(64);
  await adapter.withExclusive(path, hash, monotonicClock(), async (log) => {
    await log.append("one", { value: 1 });
    await log.append("two", { value: 2 });
  });
  const original = await readFile(path, "utf8");
  assert.equal(original.trim().split("\n").length, 2);
  const tampered = original.replace('"value":1', '"value":9');
  await writeFile(path, tampered);
  await assert.rejects(adapter.withExclusive(path, hash, monotonicClock(), async () => undefined), /journal hash mismatch/u);

  const resumePath = join(workspaceRoot, "resume.jsonl");
  const lockBytes = Buffer.from(`${JSON.stringify({ pid: 999999, host: hostname(), manifestSha256: hash, openedAt: "2026-08-08T17:59:00.000Z" })}\n`);
  await writeFile(`${resumePath}.lock`, lockBytes, { flag: "wx" });
  const staleHash = sha256(lockBytes);
  await assert.rejects(adapter.withExclusive(resumePath, hash, monotonicClock(), async () => undefined), new RegExp(staleHash, "u"));
  await adapter.withExclusive(resumePath, hash, monotonicClock(), async (log) => log.append("resumed", { audited: true }), { recoverStaleLockSha256: staleHash });
  assert.match(await readFile(resumePath, "utf8"), /"event":"resumed"/u);
  assert.deepEqual(await readFile(`${resumePath}.lock.recovered-${staleHash}`), lockBytes);
}));

test("buildPlan reports a third-state-free verification-only result", () => {
  const manifest = fixtureManifest();
  const state = classifyState(manifest, fullyMigrated(manifest, exactPages(manifest)));
  const plan = buildPlan(manifest, state);
  assert.equal(state.complete, true);
  assert.equal(plan.verificationOnly, true);
  assert.deepEqual(plan.steps.map((step) => step.id), ["preflight", "verify"]);
});
