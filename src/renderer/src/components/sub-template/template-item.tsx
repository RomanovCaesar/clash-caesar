import {
  Button,
  Card,
  CardBody,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import { IoMdMore } from 'react-icons/io'
import dayjs from '@renderer/utils/dayjs'
import React, { Key, useState } from 'react'
import { mihomoHotReloadConfig, removeSubTemplate, renameSubTemplate } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import EditorModal from './editor-modal'

interface Props {
  // 内置模版没有 item
  item?: ISubTemplateItem
  id: string
  name: string
  variant: SubTemplateVariant
  isGlobal: boolean
  onSetGlobal: () => Promise<void>
  onChanged: () => void
}

const TemplateItem: React.FC<Props> = (props) => {
  const { item, id, name, variant, isGlobal, onSetGlobal, onChanged } = props
  const { t } = useTranslation()
  const builtin = !item
  const [openEditor, setOpenEditor] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(name)

  const onMenuAction = async (key: Key): Promise<void> => {
    try {
      switch (key) {
        case 'edit':
          setOpenEditor(true)
          break
        case 'rename':
          setNewName(name)
          setRenaming(true)
          break
        case 'set-global':
          await onSetGlobal()
          break
        case 'delete':
          await removeSubTemplate(id)
          onChanged()
          await mihomoHotReloadConfig()
          break
      }
    } catch (e) {
      toast.error(String(e))
    }
  }

  const menuItems = [
    { key: 'edit', label: builtin ? t('subTemplate.menu.view') : t('subTemplate.menu.edit') },
    ...(builtin ? [] : [{ key: 'rename', label: t('subTemplate.menu.rename') }]),
    ...(isGlobal ? [] : [{ key: 'set-global', label: t('subTemplate.menu.setGlobal') }]),
    ...(builtin ? [] : [{ key: 'delete', label: t('common.delete') }])
  ]

  return (
    <div className="grid col-span-1">
      {openEditor && (
        <EditorModal
          id={id}
          name={name}
          readOnly={builtin}
          variant={builtin ? variant : undefined}
          onClose={() => {
            setOpenEditor(false)
            onChanged()
          }}
        />
      )}
      {renaming && (
        <Modal
          backdrop="blur"
          classNames={{ backdrop: 'top-[48px]' }}
          hideCloseButton
          isOpen={true}
          onOpenChange={() => setRenaming(false)}
        >
          <ModalContent>
            <ModalHeader className="flex app-drag">{t('subTemplate.menu.rename')}</ModalHeader>
            <ModalBody>
              <Input size="sm" value={newName} onValueChange={setNewName} />
            </ModalBody>
            <ModalFooter>
              <Button size="sm" variant="light" onPress={() => setRenaming(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                color="primary"
                isDisabled={newName.trim() === ''}
                onPress={async () => {
                  try {
                    await renameSubTemplate(id, newName)
                    setRenaming(false)
                    onChanged()
                  } catch (e) {
                    toast.error(String(e))
                  }
                }}
              >
                {t('common.save')}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
      <Card
        as="div"
        fullWidth
        className="cursor-pointer"
        onDoubleClick={(e) => {
          if ((e.target as Element)?.closest('button, [role="menu"], [role="menuitem"]')) return
          setOpenEditor(true)
        }}
      >
        <CardBody>
          <div className="flex justify-between h-[32px]">
            <h3
              title={name}
              className="text-ellipsis whitespace-nowrap overflow-hidden text-md font-bold leading-[32px] text-foreground"
            >
              {name}
            </h3>
            <Dropdown>
              <DropdownTrigger>
                <Button isIconOnly size="sm" variant="light" color="default">
                  <IoMdMore color="default" className="text-[24px]" />
                </Button>
              </DropdownTrigger>
              <DropdownMenu onAction={onMenuAction}>
                {menuItems.map((menu) => (
                  <DropdownItem
                    key={menu.key}
                    color={menu.key === 'delete' ? 'danger' : 'default'}
                    className={menu.key === 'delete' ? 'text-danger' : ''}
                  >
                    {menu.label}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {builtin && (
                <Chip size="sm" variant="bordered">
                  {t('subTemplate.labels.builtin')}
                </Chip>
              )}
              {isGlobal && (
                <Chip size="sm" variant="flat" color="primary">
                  {t('subTemplate.labels.global')}
                </Chip>
              )}
            </div>
            {item && <small>{dayjs(item.updated).fromNow()}</small>}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

export default TemplateItem
