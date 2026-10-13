import { useEffect } from 'react'
import useSWR from 'swr'
import { getNodeGeo, getNodeGeoStatus } from '@renderer/utils/ipc'

const EMPTY_GEO: Record<string, INodeGeo> = {}

// 节点出口位置缓存与查询进度；主进程每查完一批会通知刷新
export const useNodeGeo = (): {
  geo: Record<string, INodeGeo>
  status: INodeGeoStatus | undefined
} => {
  const { data: geo, mutate: mutateGeo } = useSWR('getNodeGeo', () => getNodeGeo())
  const { data: status, mutate: mutateStatus } = useSWR('getNodeGeoStatus', () =>
    getNodeGeoStatus()
  )

  useEffect(() => {
    return window.electron.ipcRenderer.on('nodeGeoUpdated', (_e, ...args) => {
      mutateStatus(args[0] as INodeGeoStatus, { revalidate: false })
      mutateGeo()
    })
  }, [mutateGeo, mutateStatus])

  return { geo: geo ?? EMPTY_GEO, status }
}
