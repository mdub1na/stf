# Build context: kuber/ci-runners; supply exactly one runner-package.tgz first.
FROM eclipse-temurin:21.0.10_7-jdk-jammy@sha256:25d1276565738d3c805e632a4542c3a7598866ef967f4def6544c15de3a74b14
ARG NODE_VERSION=22.18.0
ARG NODE_SHA256=c1bfeecf1d7404fa74728f9db72e697decbd8119ccc6f5a294d795756dfcfca7
ARG MAESTRO_VERSION=2.11.0
ARG MAESTRO_SHA256=5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a
RUN apt-get update && apt-get install -y --no-install-recommends       ca-certificates curl git unzip xz-utils adb lsof fontconfig     && rm -rf /var/lib/apt/lists/*     && curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz     && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check -     && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1     && rm /tmp/node.tar.xz     && curl --fail --location --retry 3 "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip" -o /tmp/maestro.zip     && echo "${MAESTRO_SHA256}  /tmp/maestro.zip" | sha256sum --check -     && unzip -q /tmp/maestro.zip -d /opt     && rm /tmp/maestro.zip     && useradd --create-home --uid 1000 --shell /bin/bash runner
COPY runner-package.tgz /tmp/runner-package.tgz
RUN npm install --global /tmp/runner-package.tgz --omit=dev --ignore-scripts     && rm /tmp/runner-package.tgz
ENV PATH="/opt/maestro/bin:${PATH}"     LANG=C.UTF-8     LC_ALL=C.UTF-8     MAESTRO_CLI_NO_ANALYTICS=true     MAESTRO_DISABLE_UPDATE_CHECK=true     MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true     MAESTRO_DRIVER_STARTUP_TIMEOUT=120000
USER 1000:1000
WORKDIR /home/runner
