import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { applyRules, type Finding } from '../src/domain/compliance';
import {
  findSimilarViolations,
  splitSentences,
  toFindings,
  type IndexedPhrase,
} from '../src/domain/semanticIndex';
import { evaluate, type Detector } from '../src/domain/screeningEval';
import { createEmbeddingProviderFromEnv } from '../src/infra/embedding/provider';
import { prisma } from '../src/server/db';
import { loadSemanticIndex } from '../src/server/semanticIndexService';

// 의미 검색 임계값 보정: npm run calibrate:semantic
//
// 임계값을 훑으며 평가셋 성적을 잰다. 고를 값의 기준은 하나다:
// **오탐률이 규칙 기준선(19.4%)을 넘지 않는 선에서 패러프레이즈 탐지율이 가장 높은 값.**
// 이 플랫폼에서 오탐은 놓친 위반보다 비싸기 때문(정상 리서처의 게시를 막아 공급을 잃는다).
//
// 임계값을 눈대중으로 정하면 나중에 왜 그 값인지 아무도 설명할 수 없게 된다.

const THRESHOLDS = [0.7, 0.74, 0.78, 0.82, 0.86, 0.9];
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function detectorAt(
  entries: IndexedPhrase[],
  vectorsBySentence: Map<string, Float32Array>,
  threshold: number,
): Detector {
  return (text: string): Finding[] => {
    const input = {
      title: '',
      summary: '',
      content: text,
      assetClass: 'KR_EQUITY' as const,
      assetName: '',
      direction: 'UP' as const,
    };
    const sentences = splitSentences(text);
    const vectors = sentences.map((s) => vectorsBySentence.get(s)).filter((v): v is Float32Array => !!v);
    const semantic =
      sentences.length === vectors.length
        ? toFindings(findSimilarViolations(sentences, vectors, entries, threshold))
        : [];
    return [...applyRules(input), ...semantic];
  };
}

async function main() {
  const provider = createEmbeddingProviderFromEnv();
  if (!provider) {
    console.log(
      '임베딩 공급자가 설정되지 않았습니다.\n' +
        'infra/embedding/provider.ts 의 createEmbeddingProviderFromEnv에 어댑터를 연결한 뒤 다시 실행하세요.\n' +
        '(모델 가중치를 받으려면 huggingface.co 네트워크 허용이 필요합니다)',
    );
    await prisma.$disconnect();
    return;
  }

  const entries = await loadSemanticIndex(prisma, provider);
  if (entries.length === 0) {
    console.log('의미 인덱스가 비어 있습니다. npm run batch:compliance 로 벡터를 채운 뒤 실행하세요.');
    await prisma.$disconnect();
    return;
  }

  // 코퍼스 문장을 한 번만 임베딩해 임계값 스윕에 재사용한다
  const sentences = [...new Set(SCREENING_CORPUS.flatMap((i) => splitSentences(i.text)))];
  const vectors = await provider.embed(sentences);
  const bySentence = new Map(sentences.map((s, i) => [s, vectors[i]]));

  console.log(`모델 ${provider.id} · 사전 ${entries.length}건 · 문장 ${sentences.length}개\n`);
  console.log('임계값   탐지율   패러프레이즈   오탐률   즉시거절오탐');
  for (const t of THRESHOLDS) {
    const r = evaluate(detectorAt(entries, bySentence, t), SCREENING_CORPUS);
    const para = r.byKind.find((k) => k.kind === 'paraphrase');
    console.log(
      `${t.toFixed(2)}   ${pct(r.recall).padStart(6)}   ${pct(para?.rate ?? 0).padStart(10)}   ` +
        `${pct(r.falsePositiveRate).padStart(6)}   ${String(r.blockingFalsePositives).padStart(6)}`,
    );
  }
  console.log(
    '\n선택 기준: 오탐률이 규칙 기준선(19.4%)을 넘지 않는 선에서 패러프레이즈 탐지율이 가장 높은 값.\n' +
      '고른 값을 domain/semanticIndex.ts 의 SIMILARITY_THRESHOLD에 반영하세요.\n',
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
