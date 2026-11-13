import type {
  GateAddressChangeImpactWire,
  GateAddressChangeStatusWire,
  GateAddressManifestComparisonWire,
} from '@nexttime/shared';
import type { ErrorOverrides } from './errors.js';
import { actionKindTagText } from './format.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * lib/gate-address-change (legacy 701): the words for moving a gate a workspace connected itself
 * to a new address — what follows it there (`impact`), why the new host's manifest blocks the
 * move (`manifest`), and where a proposal stands (`status`). The owner's three steps
 * (`components/systems/GateAddressChangeSheet`) and the platform's approval list
 * (`components/platform/integrations/GateAddressChanges`) read a change with the same lines, so
 * the administrator decides on the picture the owner proposed.
 */

/** One line per thing that follows the gate to its new address, in the order the owner checks
 *  them: what it runs, who may use it, what runs without asking, who builds on it, and what is
 *  still on its way to the old one. Every reference is by the gate's id, so none of these is
 *  touched; each applies at the new host from the moment the change is applied. */
export function gateAddressChangeImpactLines(
  impact: GateAddressChangeImpactWire,
  t: Translate,
): string[] {
  const autoApproved = impact.autoApprovedOperations.map((name) => actionKindTagText(name));
  // UX acceptance of #1158 (P3): a count of none says so, without the half that follows a count.
  const lines = [
    impact.publishedOperationCount > 0
      ? t(
          `${impact.publishedOperationCount} 个已发布的 Operation：新地址上的门必须原样提供`,
          `${impact.publishedOperationCount} published Operation(s): the gate at the new address must describe each as published`,
        )
      : t('还没有已发布的 Operation', 'No Operation is published yet'),
    impact.grantCount > 0
      ? t(
          `${impact.grantCount} 个授权：被授权的成员在新地址照样能调用`,
          `${impact.grantCount} grant(s): whoever is granted calls it at the new address too`,
        )
      : t('没有授权', 'No grants'),
    autoApproved.length > 0
      ? t(
          `自动批准的 Operation：${autoApproved.join('、')}，在新地址同样不经审批`,
          `Approved automatically: ${autoApproved.join(', ')} — at the new address too, without review`,
        )
      : t('没有自动批准的 Operation', 'No Operation is approved automatically'),
    impact.workerDefinitionCount > 0
      ? t(
          `${impact.workerDefinitionCount} 个已发布的 Worker 定义用到它`,
          `${impact.workerDefinitionCount} published Worker definition(s) use it`,
        )
      : t('没有已发布的 Worker 定义用到它', 'No published Worker definition uses it'),
  ];
  if (impact.inFlightActionRequestCount > 0) {
    lines.push(
      t(
        `${impact.inFlightActionRequestCount} 个请求还没执行：它们只在旧地址执行，换地址之后会被拒绝，要重新发起`,
        `${impact.inFlightActionRequestCount} request(s) not run yet: each runs only at the old address, so once the address changes it is refused and has to be made again`,
      ),
    );
  }
  return lines;
}

/** Why the new host's manifest blocks the move, one line per kind of difference; empty when it
 *  matches. A move never changes what the gate runs: the owner first has the gate at the new
 *  address describe what is published, moves it, then re-reads its manifest if it changed. */
export function gateAddressManifestProblems(
  manifest: GateAddressManifestComparisonWire,
  t: Translate,
): string[] {
  if (manifest.matches) return [];
  const lines: string[] = [];
  if (manifest.differing.length > 0) {
    const names = manifest.differing.map((name) => actionKindTagText(name));
    lines.push(
      t(
        `新地址上的门描述得和已发布的不同，或者这个工作区没有：${names.join('、')}`,
        `The gate at the new address describes these differently from what is published, or this workspace never had them: ${names.join(', ')}`,
      ),
    );
  }
  if (manifest.notDescribed.length > 0) {
    const names = manifest.notDescribed.map((name) => actionKindTagText(name));
    lines.push(
      t(
        `已发布、但新地址上的门没有描述：${names.join('、')}`,
        `Published, but not described by the gate at the new address: ${names.join(', ')}`,
      ),
    );
  }
  if (lines.length === 0) {
    lines.push(
      t(
        '新地址上的门描述的 Operation 和已发布的不一致',
        'The gate at the new address does not describe the published Operations as published',
      ),
    );
  }
  return lines;
}

export function gateAddressChangeStatusLabel(
  status: GateAddressChangeStatusWire,
  t: Translate,
): string {
  switch (status) {
    case 'proposed':
      return t('等平台管理员审批', 'Waiting for a platform administrator');
    case 'applied':
      return t('已换到新地址', 'Moved to the new address');
    case 'rejected':
      return t('平台管理员驳回了', 'Rejected by a platform administrator');
    case 'withdrawn':
      return t('已撤回', 'Withdrawn');
    case 'expired':
      return t('过期了，没有生效', 'Expired without taking effect');
  }
}

/** What an approval refused at the last check means to the platform administrator deciding it
 *  (review #501 of #1156): the kernel checks the new address again at approval, with the codes
 *  `create_connection` and the preview answer with, and its refusal names no other gate. Those
 *  codes' usual next steps are the workspace's ("open it under Systems & access", "mint a new
 *  secret"); here nothing changed, and what the administrator can do is reject the change, so
 *  the workspace owner proposes again. Only a gate that did not answer is worth one more try. */
export function approveGateAddressChangeErrors(t: Translate): ErrorOverrides {
  // The English sentence that follows needs its space (UX acceptance of #1158, P3).
  const notApproved = t(
    '所以没有批准，什么也没改。',
    'so it was not approved and nothing changed. ',
  );
  const rejectIt = t(
    '驳回这个申请；工作区所有者可以重新申请。',
    'Reject it; the workspace owner can propose again.',
  );
  const rejectItNewAddress = t(
    '驳回这个申请；工作区所有者可以换一个地址重新申请。',
    'Reject it; the workspace owner can propose another address.',
  );
  return {
    connection_secret_in_use: `${t(
      '申请里的新连接密钥现在属于这个工作区的另一个门，或已经用于另一次更换申请，',
      'The new connection secret in this proposal now belongs to another gate in the workspace, or served another proposal to move a gate, ',
    )}${notApproved}${t(
      '驳回这个申请；工作区所有者可以用新生成的连接密钥重新申请。',
      'Reject it; the workspace owner can propose again with a new connection secret.',
    )}`,
    endpoint_already_connected: `${t(
      '这个工作区在申请之后已经在新地址接入了别的门，',
      'Since the proposal, this workspace connected another gate at the new address, ',
    )}${notApproved}${rejectIt}`,
    endpoint_is_platform_gate: `${t(
      '新地址现在是平台提供的门实例，工作区自己接入的门不能换过去，',
      'The new address is now a gate instance the platform provides, where a gate the workspace connected itself cannot move, ',
    )}${notApproved}${rejectItNewAddress}`,
    connection_target_refused: `${t(
      '新地址现在不是平台允许连接的目标（平台网络的设置或这个地址的解析在申请之后变了），',
      'The new address is no longer a target the platform connects to (the platform’s network settings or what the address resolves to changed since the proposal), ',
    )}${notApproved}${rejectItNewAddress}`,
    manifest_fetch_failed: `${t(
      '新地址上的门没有回应（门没在那里运行、地址不通，或门上配的不是这次申请的连接密钥），',
      'The gate at the new address did not answer (it is not running there, the address cannot be reached, or it does not hold this proposal’s connection secret), ',
    )}${notApproved}${t(
      '门可能只是暂时没起来，可以稍后再批准；一直这样就驳回，由工作区所有者重新申请。',
      'If it is only down for now, approve again later; if it keeps failing, reject it and the workspace owner can propose again.',
    )}`,
    gate_address_manifest_mismatch: `${t(
      '新地址上的门描述的 Operation 和申请时不一样了，或者工作区已发布的 Operation 在申请之后变了，',
      'The gate at the new address describes other Operations than when it was proposed, or what the workspace published changed since, ',
    )}${notApproved}${rejectIt}`,
    gate_address_preview_changed: `${t(
      '这个申请或门的地址在你打开之后变了，',
      'This proposal or the gate’s address changed since you opened it, ',
    )}${notApproved}${t(
      '刷新列表再看一遍这个申请；门已经不在申请时的地址了，就驳回它。',
      'Refresh the list and read the proposal again; if the gate is no longer at the address it was proposed from, reject it.',
    )}`,
    gatekeeper_not_self_connected: `${t(
      '这个门已经不是工作区自己接入的了（它的连接被移除了），',
      'This gate is no longer one the workspace connected itself (its connection was removed), ',
    )}${notApproved}${t('驳回这个申请。', 'Reject the proposal.')}`,
  };
}

/** The steps of 「更换地址」 when the new address cannot take the gate, as the owner moving it reads
 *  them (UX acceptance of #1158, must-fix): the codes `create_connection` answers with too, whose
 *  usual next steps are for connecting a system (「重新导入」, 「重新读取门的清单」) — here nothing
 *  is imported, and what the owner does is about the gate at the new address and step ①'s secret.
 *  Built per refusal: the address rule (`details.reason`) and the gate already there
 *  (`details.gatekeeperName`) are in its details. */
export function proposeGateAddressChangeErrors(err: unknown, t: Translate): ErrorOverrides {
  const details = err instanceof HttpError ? err.details : undefined;
  const reason = typeof details?.reason === 'string' ? details.reason : undefined;
  const name = typeof details?.gatekeeperName === 'string' ? details.gatekeeperName : null;
  return {
    manifest_fetch_failed: t(
      '新地址上的门没有答出它的清单，什么也没改。最常见的原因是那扇门还没换上 ① 的连接密钥，或者换上之后没有重启：把密钥写进它的 GATE_KERNEL_TOKEN_FILE，重启门，再预览。也确认门在那个地址运行、平台连得上这个地址；具体原因在「技术细节」里。',
      'The gate at the new address did not answer for its manifest, and nothing changed. Most often it does not hold step ①’s connection secret yet, or was not restarted after getting it: put the secret in its GATE_KERNEL_TOKEN_FILE, restart the gate, and preview again. Also check the gate runs at that address and the platform can reach it; the technical details say which.',
    ),
    connection_target_refused: moveTargetRefusal(reason, t),
    endpoint_already_connected:
      name !== null
        ? t(
            `这个工作区已经在新地址接入了「${name}」，两扇门不能用同一个地址，什么也没改：换一个地址。`,
            `This workspace already connected “${name}” at the new address, and two gates cannot share one, so nothing changed: use another address.`,
          )
        : t(
            '这个工作区已经在新地址接入了另一扇门，两扇门不能用同一个地址，什么也没改：换一个地址。',
            'This workspace already connected another gate at the new address, and two gates cannot share one, so nothing changed: use another address.',
          ),
    endpoint_is_platform_gate: t(
      '新地址是平台提供的门实例，工作区自己接入的门不能换过去，什么也没改：换一个地址。',
      'The new address is a gate instance the platform provides, where a gate the workspace connected itself cannot move, so nothing changed: use another address.',
    ),
    connection_secret_in_use: t(
      '① 的连接密钥已经用过（接入过这个工作区的一扇门，或已经用于一次更换申请），什么也没改：关掉「更换地址」再打开，会签出一把新的；把它放进新地址上的门、重启门，再预览。',
      'Step ①’s connection secret was already used (it connected a gate of this workspace, or already served a move), so nothing changed: close “Move to a new address” and open it again for a new one, put that in the gate at the new address, restart it, and preview again.',
    ),
    connection_secret_expired: t(
      '① 的连接密钥已经过期（生成后 24 小时内要提交申请），什么也没改：关掉「更换地址」再打开，会签出一把新的；把它放进新地址上的门、重启门，再预览。',
      'Step ①’s connection secret has expired (a proposal must follow within 24 hours of minting it), so nothing changed: close “Move to a new address” and open it again for a new one, put that in the gate at the new address, restart it, and preview again.',
    ),
    credentials_in_connection_params: t(
      '新地址里不能带用户名、密码、查询参数（?）或片段（#），什么也没改：只填门自己的地址。',
      'The new address cannot carry a user name, password, query string (?) or fragment (#), so nothing changed: enter only the gate’s own address.',
    ),
    gate_address_manifest_mismatch: t(
      '新地址上的门描述的 Operation 和这个工作区已发布的不完全一样，什么也没改。在新主机上运行同一个门（或先重新读取这个门的清单并发布），再预览。',
      'The gate at the new address does not describe exactly the Operations this workspace published, so nothing changed. Run the same gate on the new host (or re-read and publish this gate’s manifest first), then preview again.',
    ),
  };
}

/** `connection_target_refused` for the new address, said for its rule (`details.reason`, legacy
 *  413), the way 直接注册门 says it for an endpoint (#1129). */
function moveTargetRefusal(reason: string | undefined, t: Translate): string {
  switch (reason) {
    case 'plaintext-public':
      return t(
        '新地址是公网地址，却用的是 http://，什么也没改：连接密钥和凭证会明文经过互联网。改成门的 https:// 地址；门在内网时填它的内网地址，可以继续用 http://。',
        'The new address is on the public internet but uses http://, so nothing changed: the connection secret and credentials would cross the internet unencrypted. Use the gate’s https:// address, or its in-network address, where http:// is still fine.',
      );
    case 'bare-hostname':
      return t(
        '新地址是单段主机名（平台的服务名或 localhost），平台从这里连不到，什么也没改：填门完整的域名或 IP 地址。',
        'The new address is a single-label host name (a platform service name or localhost) the platform cannot reach from here, so nothing changed: enter the gate’s full domain name or IP address.',
      );
    case 'dns-error':
      return t(
        '新地址的主机名解析不出来，什么也没改：检查拼写，或者填门的 IP 地址。',
        'The new address’s host name does not resolve, so nothing changed: check the spelling, or enter the gate’s IP address.',
      );
    case 'invalid-url':
      return t(
        '新地址不是完整的 http:// 或 https:// 地址，什么也没改。',
        'The new address is not a full http:// or https:// address, so nothing changed.',
      );
    case 'loopback':
    case 'link-local':
    case 'unspecified':
    case 'platform-subnet':
      return t(
        '新地址指向平台自己的网络或本机，平台不调用这样的地址，什么也没改：填门在网络上可达的地址。',
        'The new address points into the platform’s own networks or at the local host, which the platform does not call, so nothing changed: enter the gate’s network-reachable address.',
      );
    default:
      return t(
        '新地址不是平台允许调用的目标（指向平台自己的网络或本机，或者用 http:// 连公网地址），什么也没改：填门在网络上可达的地址，公网地址用 https://。',
        'The new address is not a target the platform calls (it points into the platform’s own networks or at the local host, or uses http:// to the public internet), so nothing changed: enter the gate’s network-reachable address, and https:// for a public one.',
      );
  }
}
