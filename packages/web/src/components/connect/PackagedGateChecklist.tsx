import { useT } from '../../lib/i18n.js';
import { GATE_ID_PATTERN } from '../../lib/platform-errors.js';
import { Notice } from '../ui/Notice.js';

export interface PackagedGateChecklistProps {
  readonly kind: 'ssh' | 'cli';
  /** The `GATE_ID` the reader intends to use — interpolated into the sample so the YAML they copy
   *  matches what the launcher then waits for. Empty → the `<gate-id>` placeholder. */
  readonly gateId?: string;
  readonly testId?: string;
}

/** The compose service name pattern of docs/runbooks/add-gatekeeper.md §4 (`gatekeeper-<system>`)
 *  — the launcher derives `<system>` from the gate id when one is typed. */
export function packagedServiceName(gateId: string): string {
  const system = gateId.trim().replace(/^gatekeeper-/, '');
  return `gatekeeper-${system.length > 0 ? system : '<system>'}`;
}

/**
 * components/connect/PackagedGateChecklist: S6-C (docs/console-completion-plan.md §5.6 "ssh /
 * cli：打包门…页面不假装能建：显示部署清单") — the deployment checklist the "接入一个系统"
 * launcher shows for an ssh / cli kind instead of a form. It is docs/runbooks/add-gatekeeper.md
 * §4 (the env-driven `gatekeeper-base` compose service) plus the P-B1 announce trio
 * (`packages/gatekeeper-base/src/announce.ts`: `GATE_ID` / `GATE_CONNECTOR` / `KERNEL_URL` and
 * the `internal_token` secret) that §4's sample predates. Every path is a placeholder
 * (`<NEXTTIME_DATA>`, `<system>`) — the public-repo red line forbids real data directories here,
 * and the reader substitutes their own from `.env`.
 *
 * Two rules the kernel enforces that a reader cannot guess from the compose file alone:
 * `GATE_CONNECTOR` must be a system-specific name, never the generic `ssh` / `cli` (a generic-kind
 * connector is `packaged: false` and `set_connector_mode` refuses `platform_preset` for it with
 * `connector_mode_not_allowed`, so the instance could never reach the workspace catalog); and the
 * instance lands `discovered` — an administrator enables it and presets the connector before a
 * workspace sees it (design §6.3 "打包门自注册").
 */
export function PackagedGateChecklist({ kind, gateId = '', testId }: PackagedGateChecklistProps) {
  const t = useT();
  const trimmed = gateId.trim();
  const idValid = trimmed.length > 0 && GATE_ID_PATTERN.test(trimmed);
  const id = idValid ? trimmed : '<gate-id>';
  const system = idValid ? trimmed.replace(/^gatekeeper-/, '') : '<system>';
  const service = packagedServiceName(idValid ? trimmed : '');
  const transportLines =
    kind === 'ssh'
      ? [
          '      GATE_SSH_HOST: <target-host>',
          '      GATE_SSH_USER: <user>',
          '      GATE_SSH_PORT: "22"',
          '      GATE_SSH_IDENTITY_FILE: /data/secrets/id_ed25519',
          '      GATE_SSH_KNOWN_HOSTS_FILE: /data/secrets/known_hosts',
          '      GATE_SSH_STRICT_HOST_KEY_CHECKING: "yes"',
        ]
      : ['      # cli: the command templates live in the manifest (binding.command_template)'];
  const compose = [
    `  ${service}:`,
    '    build: { context: ., dockerfile: packages/gatekeeper-base/Dockerfile }',
    '    secrets: [gate_token, internal_token]',
    '    environment:',
    `      GATE_TRANSPORT_KIND: ${kind}`,
    `      GATE_ID: ${id}`,
    `      GATE_CONNECTOR: ${system}`,
    `      GATE_SERVICE_NAME: ${service}`,
    '      KERNEL_URL: http://kernel:8080',
    '      GATE_MANIFEST_FILE: /data/gate-manifest.json',
    '      GATE_PORT: "8090"',
    ...transportLines,
    '    volumes:',
    `      - "\${NEXTTIME_DATA}/gatekeepers/${system}:/data/gate"`,
    `      - "\${NEXTTIME_DATA}/secrets/${system}:/data/secrets:ro"`,
    `      - "./deploy/gatekeepers/${system}-manifest.json:/data/gate-manifest.json:ro"`,
    '    networks: [control]',
    '    restart: unless-stopped',
  ].join('\n');

  return (
    <div className="stack" data-testid={testId}>
      <Notice testId="packaged-gate-notice">
        {t(
          <>
            {kind === 'ssh' ? 'SSH 主机' : '命令行'}
            门带二进制与密钥，是打包门：页面不能替你创建它，请按下面的清单起一个 compose
            服务；它启动后会自注册，出现在平台「集成 → 门实例」下（未启用
            discovered），本向导会等它出现。
          </>,
          <>
            {kind === 'ssh' ? 'An ssh' : 'A cli'} gate carries a binary and a key, so it is a
            packaged gate — this page cannot create it for you. Deploy the compose service below; on
            start it announces itself and shows up under the platform's gate instances as
            discovered, and this launcher waits for it.
          </>,
        )}
      </Notice>

      <ol className="stack-s" data-testid="packaged-gate-steps">
        <li>
          {t(
            <>
              选一个稳定的 <code>GATE_ID</code>（<code>{GATE_ID_PATTERN.source}</code>
              ）和一个<strong>系统专属</strong>的 <code>GATE_CONNECTOR</code>（不要用{' '}
              <code>{kind}</code>{' '}
              这个通用名：通用类接入包不能设为平台预置，工作区就无法从目录启用）。
            </>,
            <>
              Pick a stable <code>GATE_ID</code> ( <code>{GATE_ID_PATTERN.source}</code> ) and a{' '}
              <em>system-specific</em> <code>GATE_CONNECTOR</code> — never the generic{' '}
              <code>{kind}</code>.
            </>,
          )}
        </li>
        <li>
          {t(
            <>
              写清单 <code>deploy/gatekeepers/{system}-manifest.json</code>
              （Operation 形状见 add-gatekeeper.md §6）。
            </>,
            <>
              Write the manifest <code>deploy/gatekeepers/{system}-manifest.json</code> (see the
              operation shape in add-gatekeeper.md §6).
            </>,
          )}
        </li>
        <li>
          {t(
            <>
              密钥只放主机 <code>&lt;NEXTTIME_DATA&gt;/secrets/{system}/</code>（
              {kind === 'ssh' ? '私钥与 known_hosts 文件' : '目标命令需要的凭证'}
              ），只读挂载进容器；不进内核、不进仓库。
            </>,
            <>
              Secrets live only under the host's{' '}
              <code>&lt;NEXTTIME_DATA&gt;/secrets/{system}/</code> (
              {kind === 'ssh'
                ? 'the private key and known_hosts'
                : 'credentials the target command needs'}
              ), mounted read-only — never in the kernel, never in the repository.
            </>,
          )}
        </li>
        <li>
          {t(
            <>
              在 <code>docker-compose.yml</code> 追加服务块（additive-only）：
            </>,
            <>
              Append the service block to <code>docker-compose.yml</code> (additive-only):
            </>,
          )}
          {/* `.table-scroll` is the one existing horizontal-scroll box; a dedicated code-block
              rule (surface-2 + border + padding, tokens only) is reported for the styles lane. */}
          <div className="table-scroll">
            <pre className="mono" data-testid="packaged-gate-compose">
              {compose}
            </pre>
          </div>
        </li>
        <li>
          {t(
            <>
              <code className="mono">mkdir -p "&lt;NEXTTIME_DATA&gt;/gatekeepers/{system}"</code>
              ，然后 <code className="mono">docker compose up -d {service}</code>
              。建数据目录并启动服务。
            </>,
            <>
              <code className="mono">mkdir -p "&lt;NEXTTIME_DATA&gt;/gatekeepers/{system}"</code>,
              then <code className="mono">docker compose up -d {service}</code>. Create the data
              directory and start the service.
            </>,
          )}
        </li>
        <li>
          {t(
            <>
              启动后它 announce 到内核，出现在平台「集成 → 门实例」；管理员<strong>启用</strong>
              它并把接入包 <code>{system}</code> 设为<strong>平台预置</strong>后，工作区 owner
              才能在「系统与授权」启用。
            </>,
            <>
              After start it announces itself to the kernel and shows up under Platform →
              Integrations; once an administrator <strong>enables</strong> it and presets its
              connector <code>{system}</code> as <strong>platform-preset</strong>, a workspace owner
              can enable it on Systems.
            </>,
          )}
        </li>
      </ol>
    </div>
  );
}
