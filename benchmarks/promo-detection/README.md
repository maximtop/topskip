# Promo-detection benchmark

This tracked benchmark compares paid-sponsor detection on ten exact
timed transcripts. Self-promotion is outside the active policy.

Prompt v4: `644bd11530f049606e2a364b4046a20eb8a28a70ead1bd5dc601fae0f90f67b0`.
The default matrix contains 360 isolated
requests. Requests omit `max_tokens`, so each model uses its native
output policy. Average tokens/task uses provider-reported
`total_tokens`.
Recorded 360/360 samples; observed cost is $9.21.

## Results

Quality rank covers only complete Direct API / corpus v2 rows. It
prioritizes found reference blocks, then Detection F1, time overlap,
and boundary error. Cost and response time are shown explicitly so
the practical trade-off does not depend on hidden weighting.

- **Found refs**: reference blocks matched at >= 50% time overlap.
- **Extra**: predicted blocks with no matching reference; lower is
  better because every extra block can skip non-paid content.
- **Detection F1**: one percentage balancing missed and extra blocks;
  100% is perfect.
- **Time overlap**: average overlap with reference timing; a missed
  block contributes 0%.
- **Boundary error**: average start/end timestamp error; lower is
  better.
- **Repeat stability**: videos where all three runs agreed on whether
  promo exists and on the number of blocks.

| Quality rank | Model | Harness | Corpus | Reasoning | Valid runs | Found refs | Extra | Detection F1 | Time overlap | Boundary error | Repeat stability (promo / blocks) | Median response | Cost/task | Avg tokens/task |
| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 1 | kimi-k3 | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 6 | 90.9% | 95.7% | 0.89 s | 10/10 / 10/10 | 6.77 s | $0.0363 | 11,137 |
| 2 | gpt-5.6-sol | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 6 | 90.9% | 93.6% | 3.13 s | 10/10 / 10/10 | 4.30 s | $0.0582 | 9,782 |
| 3 | deepseek-v4-flash | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 7 | 89.6% | 96.5% | 0.91 s | 10/10 / 9/10 | 20.83 s | $0.0013 | 14,647 |
| 4 | sonnet-5 | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 7 | 89.6% | 93.1% | 1.82 s | 9/10 / 9/10 | 3.33 s | $0.0368 | 13,171 |
| 5 | grok-4.5 | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 8 | 88.2% | 96.6% | 0.75 s | 10/10 / 9/10 | 14.61 s | $0.0194 | 10,857 |
| 6 | opus-5 | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 9 | 87.0% | 99.1% | 0.29 s | 10/10 / 10/10 | 3.20 s | $0.0844 | 12,871 |
| 7 | gpt-5.6-luna | Direct API | promo-paid-v2 | default | 30/30 | 30/30 | 9 | 87.0% | 95.6% | 0.87 s | 10/10 / 8/10 | 3.65 s | $0.0025 | 9,956 |
| 8 | gemini-3.6-flash | Direct API | promo-paid-v2 | default | 30/30 | 29/30 | 4 | 92.1% | 92.1% | 1.44 s | 10/10 / 10/10 | 5.57 s | $0.0257 | 12,734 |
| 9 | hy3 | Direct API | promo-paid-v2 | default | 30/30 | 29/30 | 5 | 90.6% | 91.2% | 1.38 s | 10/10 / 9/10 | 34.55 s | $0.0030 | 13,521 |
| 10 | deepseek-v4-pro | Direct API | promo-paid-v2 | default | 30/30 | 27/30 | 4 | 88.5% | 85.3% | 1.72 s | 10/10 / 9/10 | 24.61 s | $0.0027 | 13,046 |
| 11 | gpt-5.6-terra | Direct API | promo-paid-v2 | default | 30/30 | 27/30 | 8 | 83.1% | 83.1% | 1.85 s | 10/10 / 9/10 | 2.86 s | $0.0217 | 9,646 |
| 12 | glm-5.2 | Direct API | promo-paid-v2 | default | 30/30 | 26/30 | 6 | 83.9% | 80.9% | 1.69 s | 10/10 / 9/10 | 5.93 s | $0.0149 | 10,691 |
| archive | gpt-5.6-sol | Codex agent | promo-paid-v1 | max | 30/30 | — | — | — | — | — | 10/10 / 9/10 | — | — | — |

The archive row stays unranked because corpus v1 has no curated block
references and used a different harness. It is included here only for
visibility.

## Practical choices

- **Selected production default: deepseek-v4-flash.** 30/30 references found,
  7 extra, 96.5% time overlap, 20.83 s observed response, $0.0013/task.
- **Highest paid-only detection quality: kimi-k3.** 30/30 references found,
  6 extra, 95.7% time overlap, 6.77 s response, $0.0363/task.
- **Fast paid-only alternative: sonnet-5.**
  3.33 s response, but $0.0368/task and 7 extra blocks.
- **Cheap and fast, but less safe: gpt-5.6-luna.**
  3.65 s response and $0.0025/task, but 9 extra blocks.

## Active corpus references

| Video | Language | Paid-promo reference |
| --- | --- | --- |
| mc9WVVAUQGE | en | no promo |
| daXaTug8rL4 | en | no promo |
| 5fXAELrljqs | en | 77–101.6; 852.96–911.52 |
| M51asSwRLxA | en | 262.4–312.08 |
| YP73B9D20V4 | en | 251.76–303.6 |
| v3eXTAqGkzg | ru | 242.12–331.6; 826.56–947.56; 1580.48–1600.799 |
| NOG7mWcVUeI | ru | 41.559–54.199; 740.6–798.079 |
| 7hJUNj3UjQE | ru | no paid promo |
| OpBBQpyt9EI | ru | no promo |
| OUunDHYY-xk | ru | 116–224.68 |

## Commands

```sh
pnpm benchmark:promo -- --dry-run
pnpm benchmark:promo -- --model glm-5.2
pnpm benchmark:promo
pnpm benchmark:promo -- --report-only
```

Inference requires `BENCHMARK_LLM_BASE_URL` and
`BENCHMARK_LLM_API_KEY` in the process environment or ignored
`extension/.env`. Samples never contain connection details, keys,
routing metadata, request IDs, or reasoning text.

> TODO: create a separate self-promotion corpus and prompt version.
> Never merge it into the paid-sponsor leaderboard.
