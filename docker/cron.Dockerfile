# The scheduled project-index rebuild, as its own image.
#
# Railway runs a cron service as a container to completion, so it cannot be the app
# container — that one is a long-lived web server.
#
# The command lives here, in an ENTRYPOINT, rather than in the Railway service's start
# command. That is not a style preference: an image-based cron service silently dropped its
# start command, so `curlimages/curl` ran with no arguments twice a day and printed a usage
# error instead of rebuilding anything. A command baked into the image cannot be dropped.
#
# Needs BASE_URL (or APP_URL) and CRON_SECRET in the environment.
FROM node:22-alpine

WORKDIR /app
COPY scripts/warm-index.mjs ./warm-index.mjs

# No install step and no package.json: the script uses fetch and process and nothing else,
# both built into Node 22. That keeps this image seconds to build and impossible to drift
# from the app's dependency tree.
ENTRYPOINT ["node", "/app/warm-index.mjs"]
