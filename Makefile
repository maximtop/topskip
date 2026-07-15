.PHONY: setup yt-dlp-install yt-dlp-refresh-pin build server extension lint test test-unit test-coverage test-deployment test-container test-e2e

setup:
	pnpm run setup

yt-dlp-install:
	pnpm run yt-dlp:install

yt-dlp-refresh-pin:
	pnpm run yt-dlp:refresh-pin

build:
	pnpm run build

server:
	pnpm run backend:dev

extension:
	pnpm run build:watch

lint:
	pnpm run lint


test: test-coverage test-deployment test-e2e

test-unit:
	pnpm run test

test-coverage:
	pnpm run test:coverage

test-deployment:
	pnpm run test:deployment

test-container:
	pnpm run test:container

test-e2e:
	pnpm run test:e2e
