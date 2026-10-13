import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input
} from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import React, { useEffect, useState } from 'react'
import { importSubTemplate } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import { BaseEditor } from '../base/base-editor'

interface Props {
  // 原始内容（完整订阅或模版）与建议的名称
  source: { name: string; content: string }
  onImported: (item: ISubTemplateItem) => void
  onClose: () => void
}

const ImportModal: React.FC<Props> = (props) => {
  const { source, onImported, onClose } = props
  const { t } = useTranslation()
  const [name, setName] = useState(source.name)
  const [preview, setPreview] = useState<{ content: string; stats: ISubTemplateStats }>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    importSubTemplate(source.name, source.content, true)
      .then((result) => {
        setPreview(result)
        setError('')
      })
      .catch((e) => setError(String(e)))
  }, [source])

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await importSubTemplate(name, source.content)
      if (result.item) onImported(result.item)
      onClose()
    } catch (e) {
      toast.error(String(e), t('subTemplate.error.importFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      backdrop="blur"
      classNames={{ backdrop: 'top-[48px]' }}
      size="5xl"
      hideCloseButton
      isOpen={true}
      onOpenChange={onClose}
      scrollBehavior="inside"
    >
      <ModalContent className="h-full w-[calc(100%-100px)]">
        <ModalHeader className="flex flex-col gap-2 pb-0 app-drag">
          <div>{t('subTemplate.importModal.title')}</div>
          <Input
            size="sm"
            className="app-nodrag"
            label={t('subTemplate.importModal.name')}
            value={name}
            onValueChange={setName}
          />
          {preview && (
            <small className="text-foreground-500 font-normal">
              {t('subTemplate.importModal.stats', { ...preview.stats })}
            </small>
          )}
          {error && <small className="text-danger font-normal">{error}</small>}
        </ModalHeader>
        <ModalBody className="h-full">
          <BaseEditor language="yaml" value={preview?.content ?? ''} readOnly />
        </ModalBody>
        <ModalFooter className="pt-0">
          <Button size="sm" variant="light" onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            color="primary"
            isLoading={saving}
            isDisabled={!preview || name.trim() === ''}
            onPress={onSave}
          >
            {t('subTemplate.importModal.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default ImportModal
