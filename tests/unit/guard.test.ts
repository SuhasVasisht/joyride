import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadPolicy, compilePolicy } from "../../src/modules/guard/compile.ts";
import { matchGuard, guardText } from "../../src/shared/guard-match.ts";

const policy = compilePolicy(loadPolicy(path.resolve(__dirname, "../../guard.yaml")));
const bash = (command: string) => matchGuard(policy, "Bash", { command });

describe("guard policy", () => {
  it.each([
    ["git push origin main", "git-push"],
    ["cd repo && git push", "git-push"],
    ["git -C /x/y push --force", "git-push"],
    ["gcloud run deploy api --source .", "cloud-infra"],
    ["kubectl apply -f k8s.yaml", "cloud-infra"],
    ["terraform apply -auto-approve", "cloud-infra"],
    ["docker push ghcr.io/x/y:1", "cloud-infra"],
    ["ssh devvm 'ls'", "remote-shell"],
    ["scp a.txt devvm:/tmp", "remote-shell"],
    ["rm -rf ~/Documents/old", "rm-outside"],
    ["rm -rf ../sibling", "rm-outside"],
    ["npm publish", "publish"],
    ["curl -X POST https://api.example.com/v1/x -d '{}'", "http-write"],
    ["curl https://hooks.slack.com/x --data '{\"text\":1}' ", "http-write"],
    ["gh pr create --fill", "pr-release"],
  ])("gates %s", (cmd, rule) => {
    const hit = bash(cmd);
    expect(hit?.rule).toBe(rule);
    expect(hit?.level).toBe("gate");
  });

  it.each([
    "git status", "git commit -m 'push the button'", "git log --oneline", "ls -la", "npm test",
    "gcloud config list", "gcloud projects list", "kubectl get pods", "curl https://example.com",
    "curl -X POST http://127.0.0.1:4317/api/x -d '{}'", "rm -rf node_modules", "rm -rf /tmp/joyride-test",
    "ssh-keygen -t ed25519", "echo pushd", "aws s3 ls",
  ])("allows %s", (cmd) => {
    expect(bash(cmd)?.level ?? null).not.toBe("gate");
  });

  it("flags deploy scripts as ambiguous", () => {
    expect(bash("./scripts/deploy.sh prod")?.level).toBe("ambiguous");
    expect(bash("npm run deploy")?.level).toBe("ambiguous");
  });

  it("gates MCP writes by tool name, not reads", () => {
    expect(matchGuard(policy, "mcp__claude_ai_Atlassian_Rovo__createJiraIssue", {})?.rule).toBe("jira-confluence-write");
    expect(matchGuard(policy, "mcp__claude_ai_Atlassian_Rovo__getJiraIssue", {})).toBeNull();
    expect(matchGuard(policy, "mcp__claude_ai_Slack__slack_send_message", {})?.rule).toBe("chat-email-write");
    expect(matchGuard(policy, "mcp__claude_ai_Slack__slack_read_channel", {})).toBeNull();
    expect(matchGuard(policy, "mcp__claude_ai_Microsoft_365__outlook_send_mail", {})?.rule).toBe("chat-email-write");
    expect(matchGuard(policy, "mcp__claude_ai_Microsoft_365__outlook_email_search", {})).toBeNull();
  });

  it("reads codex array commands", () => {
    expect(guardText("shell", { command: ["bash", "-lc", "git push"] })).toBe("git push");
    expect(matchGuard(policy, "shell", { command: ["bash", "-lc", "git push origin x"] })?.rule).toBe("git-push");
  });
});

describe("guard false positives", () => {
  it.each([
    "git commit -m 'gate git push and npm publish'",
    "echo 'run git push later'",
    "python3 - <<'EOF'\nprint('Gated: git push, ssh devvm')\nEOF",
    "cat > notes.md <<'EOF'\ngit push origin main\nnpm publish\nEOF",
    "grep -rn 'ssh devvm' docs/",
  ])("does not gate %s", (cmd) => {
    expect(bash(cmd)?.level ?? null).not.toBe("gate");
  });
  it.each([
    ["bash <<'EOF'\ngit push origin main\nEOF", "git-push"],
    ["sudo npm publish", "publish"],
    ["FOO=1 git push", "git-push"],
    ["echo hi && git push", "git-push"],
    ["(cd x; git push)", "git-push"],
    ["result=$(git push 2>&1)", "git-push"],
    ["env GIT_TRACE=1 git push", "git-push"],
    ["rm -rf /tmp/x ~/important", "rm-outside"],
  ])("still gates %s", (cmd, rule) => {
    const hit = bash(cmd);
    if (rule) expect(hit?.rule).toBe(rule);
  });
});

describe("rm-outside temp dirs", () => {
  it.each(["rm -rf /tmp/joyride-unit-* /tmp/joyride-e2e", "rm -rf /private/tmp/x", "rm -rf node_modules dist"])("allows %s", (cmd) => expect(bash(cmd)).toBeNull());
  it.each(["rm -rf /tmp/a ~/important", "rm -rf /Users/x/proj", "rm -rf $HOME/.cache", "rm -rf ../other"])("gates %s", (cmd) => expect(bash(cmd)?.rule).toBe("rm-outside"));
});
