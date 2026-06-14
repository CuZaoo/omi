import * as React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import { useDevice } from '../modules/useDevice';
import { DeviceView } from './DeviceView';

export const Main = React.memo(() => {
    const deviceController = useDevice();

    return (
        <SafeAreaView style={styles.container}>
            <DeviceView deviceController={deviceController} />
        </SafeAreaView>
    );
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: '100vh' as never,
        backgroundColor: '#071012',
    },
});
