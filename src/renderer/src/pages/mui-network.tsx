import { Button, Card, CardBody, Chip, Select, SelectItem, Spinner, Tooltip } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { toast } from '@renderer/components/base/toast'
import {
  getFilePath,
  importMuiNetworkFile,
  importMuiSubscription,
  listMuiNetworks,
  loginMuiNetwork,
  readTextFile,
  refreshMuiNetwork,
  removeMuiNetwork,
  setMuiUsername
} from '@renderer/utils/ipc'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FaPlus } from 'react-icons/fa6'
import { IoMdRefresh } from 'react-icons/io'
import { LuNetwork } from 'react-icons/lu'
import { MdDeleteForever, MdLogin } from 'react-icons/md'
import useSWR from 'swr'

// 主进程的错误带 [mui:code] 前缀，按 code 翻译成界面语言
function useMuiError(): (e: unknown) => string {
  const { t } = useTranslation()
  return (e: unknown): string => {
    const text = String(e)
    const match = text.match(/\[mui:(\w+)\]\s*(.*)$/)
    if (!match) return text
    const key = `muiNetwork.error.${match[1]}`
    const translated = t(key)
    return translated === key ? match[2] : translated
  }
}

const NodeStatus: React.FC<{ node: IMuiNode }> = ({ node }) => {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Chip size="sm" variant="flat" color={node.meshOnline ? 'success' : 'default'}>
        {node.meshOnline ? t('muiNetwork.meshOnline') : t('muiNetwork.meshOffline')}
      </Chip>
      {node.checkedAt !== undefined && (
        <Tooltip content={node.error || t('muiNetwork.reachableTooltip')} placement="top">
          <Chip size="sm" variant="flat" color={node.reachable ? 'primary' : 'warning'}>
            {node.reachable
              ? t('muiNetwork.reachable', { latency: node.latency ?? '—' })
              : t('muiNetwork.unreachable')}
          </Chip>
        </Tooltip>
      )}
    </div>
  )
}

const NetworkCard: React.FC<{ network: IMuiNetwork; onChanged: () => void }> = ({
  network,
  onChanged
}) => {
  const { t } = useTranslation()
  const muiError = useMuiError()
  const { profileConfig, mutateProfileConfig } = useProfileConfig()
  const [busy, setBusy] = useState<string>()
  const refreshedOnce = useRef(false)

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    success?: string
  ): Promise<void> => {
    if (busy) return
    setBusy(key)
    try {
      await action()
      if (success) toast.success(success)
    } catch (e) {
      toast.error(muiError(e))
    } finally {
      setBusy(undefined)
      onChanged()
    }
  }

  const refresh = (): Promise<void> => run('refresh', () => refreshMuiNetwork(network.id))

  // 打开页面时为已登录的网络刷新一次在线状态
  useEffect(() => {
    if (network.loggedIn && !refreshedOnce.current) {
      refreshedOnce.current = true
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network.loggedIn])

  const imported = (source: string): boolean =>
    (profileConfig?.items ?? []).some(
      (item) =>
        item.type === 'mui' &&
        item.muiNetworkId === network.id &&
        item.muiSource === source &&
        item.muiUsername === network.username
    )

  const importSubscription = (source: string, label: string): Promise<void> =>
    run(
      `import:${source}`,
      async () => {
        await importMuiSubscription(network.id, source, `${network.username} · ${label}`)
        mutateProfileConfig()
      },
      t('muiNetwork.imported')
    )

  const nodes = [...network.nodes].sort(
    (a, b) =>
      Number(b.meshOnline) - Number(a.meshOnline) ||
      Number(b.reachable ?? false) - Number(a.reachable ?? false) ||
      a.name.localeCompare(b.name)
  )

  return (
    <Card className="m-2">
      <CardBody className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <LuNetwork className="text-xl" />
          <h3 className="text-lg font-bold">{network.name}</h3>
          <Chip size="sm" variant="flat" color={network.loggedIn ? 'success' : 'warning'}>
            {network.loggedIn ? t('muiNetwork.loggedIn') : t('muiNetwork.notLoggedIn')}
          </Chip>
          <span className="text-xs text-foreground-500">
            {t('muiNetwork.panelCount', { count: network.nodes.length })}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              color={network.loggedIn ? 'default' : 'primary'}
              variant={network.loggedIn ? 'light' : 'solid'}
              startContent={<MdLogin />}
              isLoading={busy === 'login'}
              onPress={() =>
                run('login', () => loginMuiNetwork(network.id), t('muiNetwork.loginSuccess'))
              }
            >
              {network.loggedIn ? t('muiNetwork.relogin') : t('muiNetwork.login')}
            </Button>
            <Tooltip content={t('muiNetwork.refresh')}>
              <Button
                size="sm"
                isIconOnly
                variant="light"
                isDisabled={!network.loggedIn}
                onPress={refresh}
              >
                {busy === 'refresh' ? <Spinner size="sm" /> : <IoMdRefresh className="text-lg" />}
              </Button>
            </Tooltip>
            <Tooltip content={t('muiNetwork.remove')}>
              <Button
                size="sm"
                isIconOnly
                variant="light"
                color="danger"
                onPress={() => {
                  if (confirm(t('muiNetwork.confirmRemove'))) {
                    void run('remove', () => removeMuiNetwork(network.id))
                  }
                }}
              >
                <MdDeleteForever className="text-lg" />
              </Button>
            </Tooltip>
          </div>
        </div>

        {!network.loggedIn && (
          <p className="text-sm text-foreground-500">
            {network.needsLogin ? t('muiNetwork.needsLogin') : t('muiNetwork.loginHint')}
          </p>
        )}
        {network.lastError === 'unreachable' && (
          <p className="text-sm text-warning">{t('muiNetwork.error.unreachable')}</p>
        )}

        {network.loggedIn && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              size="sm"
              className="w-[220px]"
              label={t('muiNetwork.username')}
              selectedKeys={network.username ? new Set([network.username]) : new Set()}
              disallowEmptySelection
              onSelectionChange={(v) => {
                const username = v.currentKey as string
                if (username) void run('username', () => setMuiUsername(network.id, username))
              }}
            >
              {network.usernames.map((name) => (
                <SelectItem key={name}>{name}</SelectItem>
              ))}
            </Select>
            <Button
              size="sm"
              color="primary"
              isDisabled={!network.username}
              isLoading={busy === 'import:merged'}
              onPress={() => importSubscription('merged', t('muiNetwork.merged'))}
            >
              {imported('merged') ? t('muiNetwork.updateMerged') : t('muiNetwork.importMerged')}
            </Button>
          </div>
        )}

        <div className="flex flex-col divide-y divide-default-100">
          {nodes.map((node) => (
            <div key={node.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-[160px] flex-1">
                <div className="font-semibold text-sm">{node.name}</div>
                <div className="text-xs text-foreground-500 break-all">
                  {node.endpoint || t('muiNetwork.noEndpoint')}
                </div>
              </div>
              <NodeStatus node={node} />
              {network.loggedIn && (
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={!network.username}
                  isLoading={busy === `import:${node.id}`}
                  onPress={() => importSubscription(node.id, node.name)}
                >
                  {imported(node.id) ? t('muiNetwork.update') : t('muiNetwork.importSubscription')}
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

const MuiNetwork: React.FC = () => {
  const { t } = useTranslation()
  const muiError = useMuiError()
  const { data: networks = [], mutate } = useSWR('listMuiNetworks', () => listMuiNetworks())

  const importFile = async (): Promise<void> => {
    try {
      const files = await getFilePath(['muinet', 'json'])
      if (!files?.length) return
      await importMuiNetworkFile(await readTextFile(files[0]))
      toast.success(t('muiNetwork.fileImported'))
    } catch (e) {
      toast.error(muiError(e))
    } finally {
      mutate()
    }
  }

  return (
    <BasePage
      title={t('muiNetwork.title')}
      header={
        <Tooltip content={t('muiNetwork.importFile')}>
          <Button size="sm" isIconOnly variant="light" className="app-nodrag" onPress={importFile}>
            <FaPlus />
          </Button>
        </Tooltip>
      }
    >
      {networks.length === 0 ? (
        <div className="h-[calc(100vh-100px)] flex flex-col items-center justify-center gap-3 p-6 text-center">
          <LuNetwork className="text-5xl text-foreground-400" />
          <h3 className="text-lg font-semibold">{t('muiNetwork.emptyTitle')}</h3>
          <p className="max-w-md text-sm text-foreground-500">{t('muiNetwork.emptyHint')}</p>
          <Button color="primary" startContent={<FaPlus />} onPress={importFile}>
            {t('muiNetwork.importFile')}
          </Button>
        </div>
      ) : (
        networks.map((network) => (
          <NetworkCard key={network.id} network={network} onChanged={() => mutate()} />
        ))
      )}
    </BasePage>
  )
}

export default MuiNetwork
