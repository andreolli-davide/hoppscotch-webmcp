<template>
  <HoppSmartModal
    v-if="approval.pending.value"
    dialog
    title="Allow agent action?"
    aria-modal="true"
    @close="approval.resolve('deny')"
  >
    <template #body>
      <div class="flex flex-col space-y-3 px-2 text-secondaryLight">
        <p>
          An agent wants to execute a request. This can change data on a remote
          system.
        </p>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="font-semibold text-secondary">Action</dt>
          <dd>{{ approval.pending.value.action }}</dd>
          <dt class="font-semibold text-secondary">Request</dt>
          <dd>
            {{ approval.pending.value.method }}
            {{ approval.pending.value.target }}
          </dd>
          <dt class="font-semibold text-secondary">Environment</dt>
          <dd>{{ approval.pending.value.environment }}</dd>
          <dt class="font-semibold text-secondary">Workspace</dt>
          <dd>{{ approval.pending.value.workspace }}</dd>
        </dl>
      </div>
    </template>
    <template #footer>
      <span class="flex space-x-2">
        <HoppButtonPrimary
          label="Allow once"
          outline
          @click="approval.resolve('once')"
        />
        <HoppButtonSecondary
          label="Allow this session"
          outline
          filled
          @click="approval.resolve('session')"
        />
      </span>
      <HoppButtonSecondary
        label="Deny"
        outline
        filled
        @click="approval.resolve('deny')"
      />
    </template>
  </HoppSmartModal>

  <button
    v-if="activity.latest.value"
    class="fixed bottom-4 right-4 z-20 flex items-center space-x-2 rounded border border-divider bg-primary px-3 py-2 text-xs text-secondary shadow"
    type="button"
    @click="showActivity = true"
  >
    <icon-lucide-bot class="svg-icons" />
    <span>Agent: {{ activity.latest.value.summary }}</span>
  </button>

  <HoppSmartModal
    v-if="showActivity"
    title="Agent activity"
    @close="showActivity = false"
  >
    <template #body>
      <div class="max-h-96 divide-y divide-divider overflow-y-auto">
        <div
          v-for="entry in activity.entries.value"
          :key="entry.id"
          class="flex items-start justify-between gap-4 px-2 py-3"
        >
          <div class="min-w-0">
            <p class="truncate text-secondary">{{ entry.summary }}</p>
            <p class="mt-1 text-xs text-secondaryLight">
              {{ entry.tool }} · {{ entry.outcome }} ·
              {{ formatTime(entry.timestamp) }}
            </p>
          </div>
          <HoppButtonSecondary
            v-if="entry.canUndo"
            label="Undo"
            outline
            @click="activity.undo(entry.id)"
          />
        </div>
      </div>
    </template>
  </HoppSmartModal>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useService } from "dioc/vue"
import IconLucideBot from "~icons/lucide/bot"
import {
  AgentActionApprovalService,
  AgentActivityService,
} from "~/services/webmcp/human-control"

const approval = useService(AgentActionApprovalService)
const activity = useService(AgentActivityService)
const showActivity = ref(false)

const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString()
</script>
