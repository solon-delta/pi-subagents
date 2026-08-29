.PHONY: build test check fmt lint

IMAGE  := docker.io/library/node:26.5-trixie

PODMAN := podman run --rm \
          -v "$(PWD)":/work \
          -v "$(PWD)/.cache":/root/.npm \
          -w /work \
          $(IMAGE)

setup:
	$(PODMAN) npm install && $(PODMAN) npm ci

test:
	$(PODMAN) node --test "test/**/*.test.ts"

check:
	$(PODMAN) npx tsc --noEmit

fmt:
	$(PODMAN) npx oxfmt "**/*.ts" "!tools/**"

lint:
	$(PODMAN) npx oxlint
