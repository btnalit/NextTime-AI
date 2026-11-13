import type {
  GateAddressChangeImpactWire,
  GateAddressChangeStatusWire,
  GateAddressManifestComparisonWire,
} from '@nexttime/shared';
import type { ErrorOverrides } from './errors.js';
import { actionKindTagText } from './format.js';
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
  const lines = [
    t(
      `${impact.publishedOperationCount} 个已发布的 Operation：新地址上的门必须原样提供`,
      `${impact.publishedOperationCount} published Operation(s): the gate at the new address must describe each as published`,
    ),
    t(
      `${impact.grantCount} 个授权：被授权的成员在新地址照样能调用`,
      `${impact.grantCount} grant(s): whoever is granted calls it at the new address too`,
    ),
    autoApproved.length > 0
      ? t(
          `自动批准的 Operation：${autoApproved.join('、')}，在新地址同样不经审批`,
          `Approved automatically: ${autoApproved.join(', ')} — at the new address too, without review`,
        )
      : t('没有自动批准的 Operation', 'No Operation is approved automatically'),
    t(
      `${impact.workerDefinitionCount} 个已发布的 Worker 定义用到它`,
      `${impact.workerDefinitionCount} published Worker definition(s) use it`,
    ),
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
  const notApproved = t(
    '所以没有批准，什么也没改。',
    'so it was not approved and nothing changed.',
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
