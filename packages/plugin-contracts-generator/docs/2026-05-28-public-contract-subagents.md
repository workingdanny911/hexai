# PublicContract 주석 Marker Sub-Agents Handoff

## 목표

`@PublicCommand`, `@PublicQuery`, `@PublicEvent` 외에 `// @PublicContract()` 또는 JSDoc `@PublicContract()` 주석으로 일반 `class`, `interface`, `type`, `enum` 계약을 공개 추출할 수 있게 한다.

완료 기준:

- 메시지 계약은 기존처럼 `MessageRegistry`에 등록된다.
- 일반 공개 계약은 생성 output에 포함되지만 `MessageRegistry`에는 등록되지 않는다.
- TypeScript 문법상 decorator를 붙일 수 없는 `type`/`interface`는 주석 marker로 동작한다.
- 기존 `messageTypes` 필터 동작은 깨지지 않는다.
- README와 architecture/domain docs가 새 동작과 일치한다.
- 단위 테스트와 E2E가 새 동작을 검증한다.

## Harness 설계

메인 세션은 core wiring을 통합한다. Sub-Agent는 병렬 sidecar로 동작한다.

- Agent A (리뷰/리팩토링): core 구현 파일을 읽고 결함, 중복, naming drift, 하위 호환성 위험을 찾는다. 직접 수정하지 않는다.
- Agent B (문서 Drift): README와 docs를 새 PublicContract 주석 marker 모델에 맞춰 수정한다. 문서 파일만 수정한다.
- Agent C (E2E/테스트): parser/scanner/E2E 테스트와 fixture를 보강한다. 테스트/fixture 파일만 수정한다.

## 진행 기록

- Phase 1: core wiring 시작. `domain/types.ts`, `scanner.ts`, `parser.ts`, `pipeline.ts`, `config-loader.ts`, `cli.ts`, `index.ts`, `class-analyzer.ts`에 초기 변경을 적용했다.
- Phase 2: Sub-Agent A/B/C를 병렬 실행한다.
- Phase 3: Agent A 리뷰 결과를 반영해 `decoratorNames`/`contractMarkerNames` 전달, 비export PublicContract export 보정, scanner false positive 방어, target declaration 중복 출력 방지를 완료했다.
- Phase 4: Agent B 문서 drift 결과를 반영하고, 비export PublicContract도 생성 output에서 export된다는 설명으로 문서를 맞췄다.
- Phase 5: Agent C 테스트/E2E 결과를 통합하고, config marker 테스트와 scanner false-positive 테스트를 추가했다.

## 최종 검증

- `pnpm --dir packages/plugin-contracts-generator build`
- `pnpm --dir packages/plugin-contracts-generator test`

결과: build 통과, 29개 테스트 파일 / 374개 테스트 통과.
- Agent B 문서 Drift 진행: README, Architecture, Domain Model을 `PublicContract` 주석 marker 모델에 맞춰 갱신했다. 메시지 decorators는 `MessageRegistry` 대상이고, 일반 `PublicContract`는 생성 output에는 포함되지만 registry에는 등록되지 않는다는 분리를 문서화했다.
- Agent B 문서 Drift 진행: `contractMarkerNames: { contract: "PublicContract" }`, leading comment marker 지원 범위(`class`/`interface`/`type`/`enum`), `@PublicContract()` decorator 문법 미지원 제약을 반영했다.
