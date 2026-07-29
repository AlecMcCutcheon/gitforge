/** Scenario-keyed busy / rotating status copy for long Freenet ops. */

export type BusyScenario =
  | "create"
  | "restore-bundle"
  | "restore-phrase"
  | "save-profile"
  | "vault-sync"
  | "invite-send"
  | "inbox-accept"
  | "inbox-deny"
  | "about-save"
  | "generic";

const WITTY: Record<BusyScenario, string[]> = {
  create: [
    "Minting your vault…",
    "Teaching Freenet your name…",
    "Almost there — contracts are shy…",
    "Polishing fingerprint words…",
  ],
  "restore-bundle": [
    "Unwrapping the bundle…",
    "Waking the node identity…",
    "Checking for a vault on Freenet…",
    "Almost home…",
  ],
  "restore-phrase": [
    "Counting 24 words…",
    "Rebuilding seed → vault address…",
    "Pulling repo keys from the vault…",
    "Dusting off the delegate…",
  ],
  "save-profile": [
    "Signing your bio…",
    "Putting the profile contract…",
    "Freenet is taking attendance…",
  ],
  "vault-sync": [
    "Comparing vault ↔ this node…",
    "Shuffling envelope DEKs…",
    "Pushing bits into the void (politely)…",
  ],
  "invite-send": [
    "Sealing the site key…",
    "Delivering to their inbox…",
    "No carrier pigeons were harmed…",
  ],
  "inbox-accept": [
    "Importing the repo key…",
    "Updating the vault if it was in sync…",
    "Sweeping the sealed invite off Freenet…",
  ],
  "inbox-deny": [
    "Rejecting with prejudice…",
    "Scrubbing the sealed blob…",
    "Moving on — Done pile growing…",
  ],
  "about-save": [
    "Signing the About blurb…",
    "Updating the repo contract…",
    "Refreshing HubRegistry topics…",
  ],
  generic: [
    "Talking to Freenet…",
    "Waiting on the network…",
    "Still working…",
  ],
};

export function wittyMessages(scenario: BusyScenario): string[] {
  return WITTY[scenario] ?? WITTY.generic;
}

export function defaultBusyLabel(scenario: BusyScenario): string {
  switch (scenario) {
    case "create":
      return "Generating identity…";
    case "restore-bundle":
    case "restore-phrase":
      return "Restoring…";
    case "save-profile":
      return "Saving profile…";
    case "vault-sync":
      return "Syncing…";
    case "invite-send":
      return "Sending invite…";
    case "inbox-accept":
      return "Accepting…";
    case "inbox-deny":
      return "Declining…";
    case "about-save":
      return "Saving About…";
    default:
      return "Working…";
  }
}
