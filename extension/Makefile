.PHONY: setup build lint test test-unit test-coverage test-e2e

setup:
	pnpm install

build:
	pnpm run build

lint:
	pnpm run lint


test: test-unit

test-unit:
	pnpm run test

test-coverage:
	pnpm run test:coverage

test-e2e:
	pnpm run test:e2e
