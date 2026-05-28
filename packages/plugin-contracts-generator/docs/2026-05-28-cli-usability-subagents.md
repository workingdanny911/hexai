# CLI Usability Sub-Agents Handoff

## 목표

`generate-contracts` CLI를 실사용 흐름에 맞게 개선한다.

완료 기준:

- `--include all|messages|contracts`로 생성 범위를 명시할 수 있다.
- `--messages event,command,query`가 message subtype 필터의 권장 옵션이 된다.
- 기존 `-m, --message-types`는 하위 호환 alias로 유지된다.
- `--registry`가 `--generate-message-registry`의 짧은 alias로 동작한다.
- `--dry-run`은 파일 쓰기 없이 context별 추출 대상과 파일 계획을 출력한다.
- `--check`는 생성 결과가 최신인지 검사하고, 변경이 필요하면 실패한다.
- CLI, hexai plugin, docs, tests가 같은 semantics를 설명하고 검증한다.

## Harness 설계

- Agent A (CLI 패치): `src/cli.ts`, `src/hexai-plugin.ts` 중심으로 CLI 옵션과 실행 흐름을 구현한다.
- Agent B (테스트/E2E): CLI 옵션 파싱, dry-run/check/include/messages/registry alias를 테스트한다.
- Agent C (문서 Drift): README와 architecture docs의 CLI section을 업데이트한다.
- Agent D (QA): `~/projects/hzpro-dev`에서 새 git worktree를 만들고, 로컬 plugin 변경을 실제 프로젝트에 연결해 회귀 테스트한다.
- Agent E (Publish): QA 통과 후 CHANGELOG 작성, minor version bump, commit, push, publish를 수행한다.

## 옵션 Semantics

- 기본값: `--include all`, `--messages event,command,query`, registry off, dry-run/check off.
- `--include messages`: message decorators만 생성하고 PublicContract-only 파일은 제외한다.
- `--include contracts`: PublicContract만 생성하고 messages는 제외한다. registry를 요청해도 registry는 비어 있어야 한다.
- `--include all --messages event,query`: event/query messages + PublicContract를 생성한다.
- `--dry-run`: outputDir에 파일을 쓰지 않고 context별 messages/contracts/files summary를 출력한다.
- `--check`: 임시 디렉터리에 생성한 결과와 outputDir을 비교한다. 차이가 있으면 non-zero exit로 실패한다.

## 진행 기록

- Phase 1: 하네스 생성 및 Agent A/B/C dispatch.
- Phase 2 예정: 패치 통합 후 Agent D를 실행한다.
- Phase 3 예정: Agent D가 회귀 없음으로 보고하면 Agent E를 실행한다.
- Phase 2: Agent C 문서 drift 반영. README CLI usage에 `--include`, `--messages`, registry alias, `--dry-run`, `--check` 옵션과 preview/generate, messages-only, contracts-only, CI check 예시를 추가했다. ARCHITECTURE CLI 및 hexai plugin 섹션도 같은 옵션 semantics로 갱신했다.
