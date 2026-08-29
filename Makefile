.PHONY: build setup install test test-unit test-integration check fmt lint

IMAGE  := docker.io/library/node:26.5-trixie

PODMAN := podman run --rm \
          -v "$(PWD)":/work \
          -v "$(PWD)/.cache":/root/.npm \
          -w /work \
          $(IMAGE)

setup:
	$(PODMAN) npm install && $(PODMAN) npm ci

install:
	$(PODMAN) npm ci

test:
	$(PODMAN) node --test "test/**/*.test.ts"

test-unit:
	$(PODMAN) node --test "test/*.test.ts"

test-integration:
	$(PODMAN) node --test "test/integration/*.test.ts"

check:
	$(PODMAN) npx tsc --noEmit

fmt:
	$(PODMAN) npx oxfmt "**/*.ts" "!tools/**"

lint:
	$(PODMAN) npx oxlint
