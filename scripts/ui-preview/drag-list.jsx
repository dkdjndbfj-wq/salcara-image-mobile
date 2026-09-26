import React from 'react';
import { ScrollView } from 'react-native';
export const ScaleDecorator = ({ children }) => children;
export default function List({ data, renderItem, contentContainerStyle }) { return <ScrollView horizontal contentContainerStyle={contentContainerStyle}>{data.map((item, index) => <React.Fragment key={item.id}>{renderItem({ item, getIndex: () => index, drag: () => {}, isActive: false })}</React.Fragment>)}</ScrollView>; }
