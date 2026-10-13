import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import React, { useEffect, useState } from 'react'
import {
  getSubTemplateContent,
  mihomoHotReloadConfig,
  setSubTemplateContent
} from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import { BaseEditor } from '../base/base-editor'

interface Props {
  id: string
  name: string
  // 内置模版只能查看
  readOnly: boolean
  variant?: SubTemplateVariant
  onClose: () => void
}

const EditorModal: React.FC<Props> = (props) => {
  const { id, name, readOnly, variant, onClose } = props
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    getSubTemplateContent(id, variant)
      .then(setContent)
      .catch((e) => toast.error(String(e)))
  }, [id, variant])

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await setSubTemplateContent(id, content)
      await mihomoHotReloadConfig()
      onClose()
    } catch (e) {
      toast.error(String(e), t('subTemplate.error.saveFailed'))
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
        <ModalHeader className="flex pb-0 app-drag">
          {readOnly
            ? t('subTemplate.editor.viewTitle', { name })
            : t('subTemplate.editor.editTitle', { name })}
        </ModalHeader>
        <ModalBody className="h-full">
          <BaseEditor
            language="yaml"
            value={content}
            readOnly={readOnly}
            onChange={(value) => setContent(value)}
          />
        </ModalBody>
        <ModalFooter className="pt-0">
          <Button size="sm" variant="light" onPress={onClose}>
            {readOnly ? t('common.close') : t('common.cancel')}
          </Button>
          {!readOnly && (
            <Button size="sm" color="primary" isLoading={saving} onPress={onSave}>
              {t('common.save')}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default EditorModal
