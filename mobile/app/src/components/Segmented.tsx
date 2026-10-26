import SegmentedControlRaw from "@react-native-segmented-control/segmented-control"
import type { ComponentType } from "react"

// The package ships pre-React-19 class typings; the native iOS control itself is fine.
const SegmentedControl = SegmentedControlRaw as unknown as ComponentType<{
  values: string[]
  selectedIndex: number
  onChange: (event: { nativeEvent: { selectedSegmentIndex: number; value?: string } }) => void
  tintColor?: string
  style?: object
}>

export default SegmentedControl
