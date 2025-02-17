import {
  datetimeFilterToPrismaSql,
  tableColumnsToSqlFilterAndPrefix,
} from "@/src/features/filters/server/filterToPrisma";
import { orderByToPrismaSql } from "@/src/features/orderBy/server/orderByToPrisma";
import { observationsTableCols } from "@/src/server/api/definitions/observationsTable";
import { type ObservationView, Prisma } from "@prisma/client";
import { prisma } from "@/src/server/db";
import { type GetAllGenerationsInput } from "../getAllQuery";

export async function getAllGenerations({
  input,
  selectIO,
}: {
  input: GetAllGenerationsInput;
  selectIO: boolean;
}) {
  const searchCondition = input.searchQuery
    ? Prisma.sql`AND (
        o."id" ILIKE ${`%${input.searchQuery}%`} OR
        o."name" ILIKE ${`%${input.searchQuery}%`} OR
        o."model" ILIKE ${`%${input.searchQuery}%`} OR
        t."name" ILIKE ${`%${input.searchQuery}%`}
      )`
    : Prisma.empty;

  const filterCondition = tableColumnsToSqlFilterAndPrefix(
    input.filter,
    observationsTableCols,
    "observations",
  );

  const orderByCondition = orderByToPrismaSql(
    input.orderBy,
    observationsTableCols,
  );

  // to improve query performance, add timeseries filter to observation queries as well
  const startTimeFilter = input.filter.find(
    (f) => f.column === "start_time" && f.type === "datetime",
  );
  const datetimeFilter =
    startTimeFilter && startTimeFilter.type === "datetime"
      ? datetimeFilterToPrismaSql(
          "start_time",
          startTimeFilter.operator,
          startTimeFilter.value,
        )
      : Prisma.empty;

  const query = Prisma.sql`
      WITH scores_avg AS (
        SELECT
          trace_id,
          observation_id,
          jsonb_object_agg(name::text, avg_value::double precision) AS scores_avg
        FROM (
          SELECT
            trace_id,
            observation_id,
            name,
            avg(value) avg_value,
            comment
          FROM
            scores
          GROUP BY
            1,
            2,
            3,
            5
          ORDER BY
            1) tmp
        GROUP BY
          1, 2
      )
      SELECT
        o.id,
        o.name,
        o.model,
        o."modelParameters",
        o.start_time as "startTime",
        o.end_time as "endTime",
        ${selectIO ? Prisma.sql`o.input, o.output,` : Prisma.empty} 
        o.metadata,
        o.trace_id as "traceId",
        t.name as "traceName",
        o.completion_start_time as "completionStartTime",
        o.prompt_tokens as "promptTokens",
        o.completion_tokens as "completionTokens",
        o.total_tokens as "totalTokens",
        o.unit,
        o.level,
        o.status_message as "statusMessage",
        o.version,
        o.model_id as "modelId",
        o.input_price as "inputPrice",
        o.output_price as "outputPrice",
        o.total_price as "totalPrice",
        o.calculated_input_cost as "calculatedInputCost",
        o.calculated_output_cost as "calculatedOutputCost",
        o.calculated_total_cost as "calculatedTotalCost",
        o."latency",
        o.prompt_id as "promptId",
        p.name as "promptName",
        p.version as "promptVersion"
      FROM observations_view o
      JOIN traces t ON t.id = o.trace_id AND t.project_id = o.project_id
      LEFT JOIN scores_avg AS s_avg ON s_avg.trace_id = t.id and s_avg.observation_id = o.id
      LEFT JOIN prompts p ON p.id = o.prompt_id
      WHERE
        o.project_id = ${input.projectId}
        AND t.project_id = ${input.projectId}
        AND o.type = 'GENERATION'
        ${datetimeFilter}
        ${searchCondition}
        ${filterCondition}
        ${orderByCondition}
      LIMIT ${input.limit} OFFSET ${input.page * input.limit}
    `;

  const generations = await prisma.$queryRaw<
    Array<
      ObservationView & {
        traceName: string | null;
        promptName: string | null;
        promptVersion: string | null;
      }
    >
  >(query);

  const scores = await prisma.score.findMany({
    where: {
      trace: {
        projectId: input.projectId,
      },
      observationId: {
        in: generations.map((gen) => gen.id),
      },
    },
  });

  const fullGenerations = generations.map((generation) => {
    const filteredScores = scores.filter(
      (s) => s.observationId === generation.id,
    );
    return {
      ...generation,
      scores: filteredScores,
    };
  });

  return {
    generations: fullGenerations,
    datetimeFilter,
    searchCondition,
    filterCondition,
  };
}
