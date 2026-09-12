-- 0024_gate_host_instances — P-B2a 门宿主实例（docs/development-tasks.md P-B 决定 ⑦）。
--
-- 宿主实例就是 gate_instances 的一行：管理员在集成页创建，`hosted = true`，`definition` 记传输种类、目标
-- 地址、凭证模式与 manifest 来源（绝无凭证）；通用门宿主经内部面拉取这些定义并逐个 announce，之后的存活、
-- 链接、禁用名单与打包门完全一样。`endpoint` 在宿主接管前为空串，由第一次 announce 填。
alter table gate_instances add column if not exists hosted boolean not null default false;
alter table gate_instances add column if not exists definition jsonb;
alter table gate_instances drop constraint if exists gate_instances_hosted_definition;
alter table gate_instances add constraint gate_instances_hosted_definition
  check ((hosted and definition is not null) or (not hosted and definition is null));

-- 删除宿主实例（无链接时）走平台事务；RLS 策略 gate_instances_platform_admin（0023）已覆盖 delete。
grant delete on gate_instances to nexttime_app;
