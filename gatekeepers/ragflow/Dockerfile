# syntax=docker/dockerfile:1.7
#
# Placeholder image for the "ragflow" gatekeeper content package (design doc §7.5, §7.10). Its
# manifest.yaml/policy.yaml/mappings/skills live in this directory and are the actual content
# once implemented (S2).
# NOTE (R1): image build is unverified on this machine — Docker is not installed here. It must
# be built and smoke-tested on the target host before E3 sign-off.

FROM node:24-bookworm-slim
RUN groupadd --system --gid 10001 nexttime \
 && useradd --system --uid 10001 --gid nexttime --home-dir /app --shell /usr/sbin/nologin nexttime

WORKDIR /app
USER nexttime
CMD ["node", "--eval", "console.log('gatekeeper-ragflow: placeholder image, not implemented until S2')"]
