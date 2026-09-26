'use strict'

/**
 * mistake-analyzer 反馈阶段插件
 * 把"做错了"变成"知道为什么错、下一步干什么"：
 *   拉取错题作答 → 规则归因（粗心作答 / 知识薄弱 / 生疏）→ 分类报告 + 一键动作；
 *   支持差评退回（retired）让坏题退出队列——反馈闭环的最后一环。
 */

const PLUGIN_ID = 'mistake-analyzer'

module.exports = {
  id: PLUGIN_ID,
  name: '错因分析官',
  version: '0.3.0',
  description: '反馈阶段：错题归因（粗心/薄弱/生疏）+ 概念级薄弱分布（本体 P2）+ 差评退回，反馈闭环最后一环',

  activate(context) {
    context.registerAgentTool(
      {
        name: 'analyze_mistakes',
        description: '分析近期错题并归因：reaction_ms<3s 判"粗心作答"（建议重做）、同一知识点/文档连错≥2 判"知识薄弱"（建议重学与重练）、仅错一次判"生疏"（建议巩固）。产出「错因分析」表格，经 show_view 自动在编辑器内容区展开（无需用户操作，也没有其他查看位置）。用户说"分析错题/为什么错/薄弱在哪"时使用。回复要求：只简述结论与归因计数；若输出含「概念级薄弱分布」段必须原样保留；不要描述结果出现的位置或表面（展示由系统自动完成）。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '分析最近多少条错答，默认 30' }
          }
        }
      },
      async (args) => {
        const limit = Math.min(Number(args.limit) || 30, 100)
        const rows = (await context.query(
          `SELECT qa.question_id, qa.reaction_ms, qa.answered_at,
                  q.question, q.type, q.document_id, q.knowledge_point_id, q.status
           FROM question_attempts qa
           JOIN questions q ON q.id = qa.question_id
           WHERE qa.correct = 0
           ORDER BY qa.answered_at DESC
           LIMIT ?`,
          [limit]
        )) || []
        // ⚠️ ctx.query 列名经 toCamelCaseRow 转驼峰（question_id → questionId）——
        // 真机 E2E 实证：按 snake_case 取值恒为 undefined（薄弱误判 + 明细 ID 全 undefined），禁改回
        const byId = (r) => r
        if (rows.length === 0) {
          return { output: '近期没有错答记录。要么学得很好，要么还没有开始做题（先出题练习，才有反馈数据）。' }
        }

        // 同知识点/文档错答计数（知识薄弱判定）
        const kpWrong = new Map()
        for (const r of rows) {
          const key = r.knowledgePointId || r.documentId
          kpWrong.set(key, (kpWrong.get(key) || 0) + 1)
        }

        const classified = rows.map((r) => {
          const key = r.knowledgePointId || r.documentId
          let cause = '生疏（首次答错，建议巩固）'
          let action = '加入近期复习队列'
          if ((r.reaction_ms || 99999) < 3000) {
            cause = '粗心作答（3 秒内提交）'
            action = '建议重做一遍同一题'
          } else if (kpWrong.get(key) >= 2) {
            cause = '知识薄弱（同一范围连错≥2）'
            action = '回读原文 + 重新出题练习'
          }
          return {
            question: String(r.question || '').slice(0, 60),
            questionId: r.questionId,
            type: r.type,
            cause,
            action,
            status: r.status
          }
        })

        const idList = classified.map((c) => `${c.questionId}（${c.cause.split('（')[0]}）`).join('\n')
        const counts = classified.reduce((m, c) => { m[c.cause] = (m[c.cause] || 0) + 1; return m }, {})
        const summary = Object.entries(counts).map(([k, v]) => `${k} × ${v}`).join('；')

        // ---- 概念级薄弱分布（本体 P2，2026-09-20 计划）：错题 → KP → 已确认概念聚合 + 未覆盖 KP 补候选 ----
        let weakConceptLines = []
        let metaWeakConcepts = []
        const conceptTitleByQuestion = new Map()
        const conceptByKp = new Map()
        let weakConcepts = new Map()
        try {
          const weakKpIds = [...new Set(rows
            .filter((r) => classified.find((c) => c.questionId === r.questionId && c.cause.startsWith('知识薄弱')) && r.knowledgePointId)
            .map((r) => r.knowledgePointId))]
          if (weakKpIds.length > 0) {
            const mapped = (await context.query(
              `SELECT kc.kp_id AS kpId, kc.concept_id AS conceptId, c.title, c.status
               FROM kp_concepts kc JOIN concepts c ON c.id = kc.concept_id
               WHERE kc.kp_id IN (${weakKpIds.map(() => '?').join(',')})`,
              weakKpIds
            )) || []
            const weakCountByQ = new Map()
            for (const r of rows) {
              if (r.knowledgePointId && weakKpIds.includes(r.knowledgePointId)) {
                weakCountByQ.set(r.knowledgePointId, (weakCountByQ.get(r.knowledgePointId) || 0) + 1)
              }
            }
            for (const m of mapped) {
              if (m.status !== 'confirmed') continue
              const n = weakCountByQ.get(m.kpId) || 0
              const prev = weakConcepts.get(m.conceptId) || { title: m.title, n: 0 }
              prev.n += n
              weakConcepts.set(m.conceptId, prev)
            }
            // 每行概念归属（UX 走查 #3：概念分布结构化进表格列，不依赖模型转述）
            for (const m of mapped) if (m.status === 'confirmed') conceptByKp.set(m.kpId, m.title)
            weakConceptLines = [...weakConcepts.values()].sort((a, b) => b.n - a.n).map((w) => `🎯 ${w.title}（${w.n} 题薄弱）——建议在知识体系中定位并专项补强`)
            // 未绑定概念的薄弱 KP → 产出候选绑定（source=llm，draft 进确认队列——本体 P2 生产侧）
            const coveredKp = new Set(mapped.map((m) => m.kpId))
            for (const kpId of weakKpIds) {
              if (coveredKp.has(kpId)) continue
              let kpTitle = ''
              try {
                const kpr = (await context.query('SELECT title FROM knowledge_points WHERE id = ?', [kpId])) || []
                kpTitle = kpr[0]?.title || ''
              } catch { kpTitle = '' }
              if (kpTitle && typeof context.attachKpToConceptByTitle === 'function') {
                await context.attachKpToConceptByTitle({ kpId, title: kpTitle, source: 'llm' })
              }
            }
          }
        } catch { /* 概念归因是增强面，失败不阻塞三分类主报告 */ }

        const weakConceptBlock = weakConceptLines.length > 0
          ? `\n\n🎯 概念级薄弱分布（跨文档聚合，可让小诺「带我去看看X」定位）：\n${weakConceptLines.join('\n')}`
          : ''
        const output = `🔍 近期错答 ${rows.length} 条，归因如下：\n${summary}\n\n明细（含题目 ID，可直接用于 retire_question）：\n${idList}\n\n粗心类建议"重做"，薄弱类建议"回读原文 + 重出题"（可用 generate_cloze_quiz）。差评的坏题用 retire_question 退回。${weakConceptBlock}`
        // 概念列注入（不依赖模型转述）
        for (const r of rows) {
          if (!r.knowledgePointId) continue
          const t = conceptByKp.get(r.knowledgePointId)
          if (t) conceptTitleByQuestion.set(r.questionId, t)
        }
        classified.forEach((c) => { c.concept = conceptTitleByQuestion.get(c.questionId) || '' })
        metaWeakConcepts = [...weakConcepts.values()].map((w) => ({ title: w.title, weakCount: w.n }))
        return {
          output,
          ui: { intent: 'show_view', view: { title: '错因分析', columns: [
            { key: 'question', label: '题目' }, { key: 'questionId', label: '题目ID' }, { key: 'type', label: '题型' },
            { key: 'concept', label: '概念' },
            { key: 'cause', label: '归因' }, { key: 'action', label: '建议动作' }
          ], rows: classified.slice(0, 30) } },
          meta: { weakConcepts: metaWeakConcepts }
        }
      }
    )

    context.registerAgentTool(
      {
        name: 'retire_question',
        description: '把一道差评题退出复习队列（status→retired），同时记录 bad_question 反馈。用户明确说"这题出得不行/别再出这题"时使用。退回后题目保留在库（数据归用户）但不再进入复习。',
        parameters: {
          type: 'object',
          properties: {
            questionId: { type: 'string', description: '题目 ID' },
            reason: { type: 'string', description: '退回原因（可选）' }
          },
          required: ['questionId']
        }
      },
      async (args) => {
        await context.retireQuestion(String(args.questionId))
        await context.flagQuestionFeedback({
          questionId: String(args.questionId),
          kind: 'bad_question',
          note: String(args.reason || '').slice(0, 200)
        })
        return {
          output: `✅ 题目已退回（retired），不再进入复习队列；反馈已记录${args.reason ? `：${args.reason}` : ''}。反悔了可到侧边栏「题目库」找到该题（状态「已下架」），点行内「恢复」找回。`,
          ui: { intent: 'notify', type: 'success', message: '题目已退回，反馈已记录' }
        }
      }
    )
  },

  deactivate() {}
}
